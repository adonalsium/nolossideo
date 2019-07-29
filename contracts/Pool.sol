pragma solidity 0.5.0;

import "openzeppelin-eth/contracts/token/ERC20/IERC20.sol";
import "openzeppelin-eth/contracts/math/SafeMath.sol";
import "./compound/ICErc20.sol";
import "openzeppelin-eth/contracts/ownership/Ownable.sol";
import "kleros/contracts/data-structures/SortitionSumTreeFactory.sol";
import "./UniformRandomNumber.sol";
import "fixidity/contracts/FixidityLib.sol";

/**
 * @title The Pool contract for PoolTogether
 * @author Brendan Asselstine
 * @notice This contract implements a "lossless pool".  The pool exists in three states: open, locked, and complete.
 * The pool begins in the open state during which users can buy any number of tickets.  The more tickets they purchase, the greater their chances of winning.
 * After the lockStartBlock the owner may lock the pool.  The pool transfers the pool of ticket money into the Compound Finance money market and no more tickets are sold.
 * After the lockEndBlock the owner may unlock the pool.  The pool will withdraw the ticket money from the money market, plus earned interest, back into the contract.  The fee will be sent to
 * the owner, and users will be able to withdraw their ticket money and winnings, if any.
 * @dev All monetary values are stored internally as fixed point 24.
 */

// WARNING: This contract will break if the amount of interest earned is negative (is that possible?).

contract Pool is Ownable {
  using SafeMath for uint256;

  /**
   * Emitted when "tickets" have been purchased.
   * @param sender The purchaser of the tickets
   * @param count The number of tickets purchased
   * @param totalPrice The total cost of the tickets
   */
  event BoughtTickets(address indexed sender, int256 count, uint256 totalPrice);

  /**
   * Emitted when a user withdraws from the pool.
   * @param sender The user that is withdrawing from the pool
   * @param amount The amount that the user withdrew
   */
  event Withdrawn(address indexed sender, int256 amount, int256 remainingTickets);

  /**
   * Emitted when the pool is locked.
   */
  event PoolLocked();

  /**
   * Emitted when the pool is unlocked.
   */
  event PoolUnlocked();

  event TotalWinnings(int theWholeShebang);

  /**
   * Emitted when the pool is complete. Total Winnings is unifixed.
   */
  event DrawingComplete(int256 winningGroup, int256 totalWinnings);

  struct Entry {
    address addr;
    // this may be unneeded and expensive but I'll optimize later
    // it shows up twice: in the struct and as the key in users dict
    string username;
    int256 amount; // this is fixedPoint24
    int256 ticketCount;
    int256 totalWinnings; // this is fixedPoint24
    int256 groupId;
    // TODO: collectibles
  }

  struct PendingEntry {
    address addr;
    int256 amount; // fixedPoint24
    int256 ticketCount;
  }

  struct Group {
    address[] members;
    // this are the members that are authorized to join the group
    // every member has invite access
    address[] allowedEntrants;
    // ticketCount: computed from members in frontend
    // amount: computed from members in frontend
  }

  bytes32 public constant SUM_TREE_KEY = "PoolPool";
  bool public hasActivated = false;

  // total principle
  int256 private principleAmount; // fixed point 24
  bytes32 private secretHash;
  bytes32 private secret;
  // total principle + interest
  int256 private finalAmount; //fixed point 24
  // winnings from previous draws that are unclaimed and therefore still in compound
  int256 private unclaimedWinnings; // fixed point 24
  // When new winnings are calculated in each drawing, the prize pool is calculated as
  // finalAmount - unclaimedWinnings - principleAmount

  // TODO: optimize
  // We need to keep this... stored twice. Not pretty
  // Needed to access the entry for msg.sender
  mapping (address => Entry) private activeEntries;
  // needed to invite by username
  mapping (string => address) private users;
  //mapping of groups
  Group[] private groups;
  mapping (address => PendingEntry) private pendingEntries;
  // Needed to loops over pendingEntries in activateEntries
  address[] pendingAddresses;

  uint256 public entryCount;
  ICErc20 public moneyMarket;
  IERC20 public token;
  int256 private ticketPrice; //fixed point 24
  int256 private feeFraction; //fixed point 24
  address private winningAddress;
  int256 private winningGroup;

  using SortitionSumTreeFactory for SortitionSumTreeFactory.SortitionSumTrees;
  SortitionSumTreeFactory.SortitionSumTrees internal sortitionSumTrees;

  /**
   * @notice Creates a new Pool.
   * @param _moneyMarket The Compound money market to supply tokens to.
   * @param _token The ERC20 token to be used.
   * @param _ticketPrice The price of each ticket (fixed point 18)
   * @param _feeFractionFixedPoint18 The fraction of the winnings going to the owner (fixed point 18)
   * @param _secretHash the secret hash for the first drawing
   */
  constructor (
    ICErc20 _moneyMarket,
    IERC20 _token,
    int256 _ticketPrice,
    int256 _feeFractionFixedPoint18,
    bytes32 _secretHash
  ) public {
    require(address(_moneyMarket) != address(0), "money market address cannot be zero");
    require(address(_token) != address(0), "token address cannot be zero");
    require(_ticketPrice > 0, "ticket price must be greater than zero");
    require(_feeFractionFixedPoint18 >= 0, "fee must be zero or greater");
    require(_feeFractionFixedPoint18 <= 1000000000000000000, "fee fraction must be less than 1");
    feeFraction = FixidityLib.newFixed(_feeFractionFixedPoint18, uint8(18));
    ticketPrice = FixidityLib.newFixed(_ticketPrice);
    sortitionSumTrees.createTree(SUM_TREE_KEY, 4);
    secretHash = _secretHash;
    moneyMarket = _moneyMarket;
    token = _token;
    unclaimedWinnings = FixidityLib.newFixed(0);
  }

  modifier hasEntry {
    require(activeEntries[msg.sender].addr == msg.sender, "The user has not yet entered the game. Buy a ticket first.");
    _;
  }

  event CheckPoint(int theGroupNum);

  modifier hasGroup {
    require(activeEntries[msg.sender].addr == msg.sender, "The user has not yet entered the game. Buy a ticket first.");
    emit CheckPoint(activeEntries[msg.sender].groupId);
    require(activeEntries[msg.sender].groupId >= 0, "The user has not created or joined a group yet.");
    _;
  }

  modifier isSolo {
    require(activeEntries[msg.sender].addr == msg.sender, "The user has not yet entered the game. Buy a ticket first.");
    require(activeEntries[msg.sender].groupId == -1, "The user is already in a group. They should leave before joining another.");
    _;
  }

  function getUnclaimedWinnings() external view returns (int256) {
    return FixidityLib.fromFixed(unclaimedWinnings);
  }

  /**
   * @notice deletes the element at a given index from the array
   * @param index the index to delte
   * @param array the array to modify
   * @author jmartinmcfly (copied from https://ethereum.stackexchange.com/questions/1527/how-to-delete-an-element-at-a-certain-index-in-an-array/1528)
   */
  function _burn(uint256 index, address[] storage array) internal {
    require(index < array.length, "Bad Index");
    array[index] = array[array.length-1];
    delete array[array.length-1];
    array.length--;
  }

  // getter for groups
  function getGroupId(address _addr) public view returns (int256) {
    return activeEntries[_addr].groupId;
  }

  function getGroup(uint256 groupId) public view returns (
    address[] memory members,
    address[] memory allowedEntrants
  ) {
    Group storage theGroup = groups[groupId];
    return (theGroup.members, theGroup.allowedEntrants);
  }

  event NewGroupMade(int idNewGroup);
  event NewGroupAddress(address theaddie);

  /**
   * @notice Creates a new group and places msg.sender within it
   */
   // WARNING: this may not work. I may need to make a mapping for groups
   //           and store the keys for that mapping in an array
  function createGroup() external hasEntry {
    int newGroupId = int(groups.length);
    emit NewGroupMade(newGroupId);
    groups.length += 1;
    Group storage newGroup = groups[uint(newGroupId)];
    newGroup.members.push(msg.sender);
    Entry storage senderEntry = activeEntries[msg.sender];
    senderEntry.groupId = newGroupId;
    emit NewGroupMade(senderEntry.groupId);
    emit NewGroupAddress(senderEntry.addr);
    emit NewGroupAddress(msg.sender);
  }

  /**
   * @notice Puts a user in a group if they've been invited and removes them from
   *  the allowed invite list.
   * @param _groupId The group to join
   * @author jmartinmcfly
   */
  function joinGroup(int256 _groupId) external hasEntry isSolo {
    // require the the user is in allowed
    Group storage theGroup = groups[uint(_groupId)];
    bool isAllowed = false;
    for (uint i = 0; i < theGroup.allowedEntrants.length; i++) {
      if (theGroup.allowedEntrants[i] == msg.sender) {
        isAllowed = true;
        // WARNING: This may get funky because storage
        _burn(i, theGroup.allowedEntrants);
      }
    }
    require(isAllowed, "You do not have permission to join this group.");
    theGroup.members.push(msg.sender);
    // change the entry to match the new group status
    Entry storage newGroupMember = activeEntries[msg.sender];
    newGroupMember.groupId = _groupId;
  }

  /**
  * @notice Makes msg.sender leave their given group and become a solo player
  * @author jmartinmcfly
  */
  function leaveGroup() external hasEntry hasGroup {
    Entry storage senderEntry = activeEntries[msg.sender];
    // WARNING: This may get funky because storage
    Group storage group = groups[uint(getGroupId(msg.sender))];
    uint index = group.members.length;
    for (uint i = 0; i < group.members.length; i++) {
      if (group.members[i] == msg.sender) {
        index = i;
      }
    }
    require(index < group.members.length, "Something went wrong with the leave op!");
    // remove the msg.sender from the list of members
    _burn(index, group.members);
    // set the groupId of the user to -1 aka "does not exist"
    senderEntry.groupId = -1;
  }

  event TesterGroupID(int256 theGroup);
  event TesterAddress(address theAddressInvitee);
  event TesterGroupState(uint256 theLength);

  /**
  * @notice Gives the passed user permission to join the group of msg.sender
  * @param _username the username of the user to invite
  * @author jmartinmcfly
  */
  function invite(string calldata _username) external hasEntry hasGroup {
    // require that the user "_username" exists
    require(users[_username] != address(0), "User doesn't exist");
    address inviteeAddress = users[_username];
    emit TesterAddress(inviteeAddress);
    int256 groupId = activeEntries[msg.sender].groupId;
    emit TesterGroupID(groupId);
    emit TesterGroupState(groups.length);
    Group storage invitingGroup = groups[uint(groupId)];
    invitingGroup.allowedEntrants.push(inviteeAddress);
  }

  function setUsername(string calldata _username) external {
    if (_hasEntry(msg.sender)) {
      users[_username] = msg.sender;
      Entry storage entryToModify = activeEntries[msg.sender];
      entryToModify.username = _username;
    } else {
      activeEntries[msg.sender] = Entry(
        msg.sender,
        _username,
        0,
        0,
        0,
        -1
      );
      users[_username] = msg.sender;
    }
  }

  event Pender(int256 theThing);
  event SuperPender(int256 OGCount);
  event BalanceEvent(uint256 depositedBalance);

  /**
   * @notice Buys a pool ticket.  Only possible while the Pool is in the "open" state.  The
   * user can buy any number of tickets.  Each ticket is a chance at winning.
   * @param _countNonFixed The number of tickets the user wishes to buy.
   */
  function buyTickets (int256 _countNonFixed) public {
    require(_countNonFixed > 0, "number of tickets is less than or equal to zero");
    int256 count = FixidityLib.newFixed(_countNonFixed);
    int256 totalDeposit = FixidityLib.multiply(ticketPrice, count);
    uint256 totalDepositNonFixed = uint256(FixidityLib.fromFixed(totalDeposit));
    require(token.transferFrom(msg.sender, address(this), totalDepositNonFixed), "token transfer failed");

    // send the newly sent tokens to the moneymarket
    require(token.approve(address(moneyMarket), totalDepositNonFixed), "could not approve money market spend");
    emit BalanceEvent(totalDepositNonFixed);
    // TODO: DOES THIS WORK? Can you mint twice?
    require(moneyMarket.mint(totalDepositNonFixed) == 0, "could not supply money market");

    if (_hasEntry(msg.sender)) {
      if (!_hasPendingEntry(msg.sender)) {
        pendingAddresses.push(msg.sender);
        emit SuperPender(_countNonFixed);
        pendingEntries[msg.sender] = PendingEntry(msg.sender, totalDeposit, _countNonFixed);
      } else {
        emit Pender(pendingEntries[msg.sender].amount);
        emit Pender(totalDeposit);
        pendingEntries[msg.sender].amount = FixidityLib.add(pendingEntries[msg.sender].amount, totalDeposit);
        emit Pender(pendingEntries[msg.sender].amount);
        emit Pender(pendingEntries[msg.sender].ticketCount);
        pendingEntries[msg.sender].ticketCount = pendingEntries[msg.sender].ticketCount + _countNonFixed;
        emit Pender(pendingEntries[msg.sender].ticketCount);
      }
    } else {
      activeEntries[msg.sender] = Entry(
        msg.sender,
        "",
        FixidityLib.newFixed(0),
        0,
        FixidityLib.newFixed(0),
        -1
      );
      emit SuperPender(_countNonFixed);
      pendingEntries[msg.sender] = PendingEntry(msg.sender, totalDeposit, _countNonFixed);
      emit SuperPender(pendingEntries[msg.sender].ticketCount);
      emit SuperPender(pendingEntries[msg.sender].amount);
      entryCount = entryCount.add(1);
    }

    principleAmount = FixidityLib.add(principleAmount, totalDeposit);

    // the total amount cannot exceed the max pool size
    require(principleAmount <= maxPoolSizeFixedPoint24(FixidityLib.maxFixedDiv()), "pool size exceeds maximum");

    emit BoughtTickets(msg.sender, _countNonFixed, totalDepositNonFixed);
  }

  /**
   * @notice Selects a winning address (and therefore group) and
   * updates winnings of winning group members.
   * @param _secret the secret for this drawing
   * @param _newSecretHash the hash of the secret for the next drawing
   * Fires the PoolUnlocked event.
   */
  function draw(bytes32 _secret, bytes32 _newSecretHash) public onlyOwner {
    require(hasActivated, "the pool has not been activated yet");
    require(keccak256(abi.encodePacked(_secret)) == secretHash, "secret does not match");
    // we store the secret in the contract for ease of passing around and so
    // users can (with some annoyance) recreate a drawing themselves
    secret = _secret;
    winningAddress = calculateWinner();
    winningGroup = activeEntries[winningAddress].groupId;
    require(_newSecretHash != 0, "secret hash must be defined");
    // set new secret hash for next drawing
    secretHash = _newSecretHash;
    int256 totalWinningsFixed = updatePayouts(winningAddress);
    // pay the owner their fee
    uint256 fee = feeAmount();
    if (fee > 0) {
      require(token.transfer(owner(), fee), "could not transfer winnings");
    }

    // shift entries from pendingEntries to activeEntries
    activateEntriesInternal();
    emit DrawingComplete(winningGroup, FixidityLib.fromFixed(totalWinningsFixed));
  }

  /**
    * @notice Shifts all inactive entries to active entries and updates sortition tree/
    *   This will normally only be called by draw. However, before the first ever drawing
    *   in the history of the contract, this will be called manually by the pool operator.
    * @author jmartinmcfly
   */
   // TODO: address potential gas limit issues here
  function activateEntries() public onlyOwner {
    require(!hasActivated, "You have already activated the pool");
    hasActivated = true;
    // update Entries
    for (uint i = 0; i < pendingAddresses.length; i++) {
      PendingEntry storage current = pendingEntries[pendingAddresses[i]];
      Entry storage currentActive = activeEntries[current.addr];
      currentActive.amount = FixidityLib.add(current.amount, currentActive.amount);
      currentActive.ticketCount = currentActive.ticketCount + current.ticketCount;
      //clear the pendingEntry
      current.amount = FixidityLib.newFixed(0);
      current.ticketCount = 0;
      // update sortition tree entry
      sortitionSumTrees.set(SUM_TREE_KEY, uint256(FixidityLib.fromFixed(currentActive.amount)), bytes32(uint256(current.addr)));
    }

    delete pendingAddresses;
  }

  /**
    * @notice Shifts all inactive entries to active entries and updates sortition tree/
    *   This will normally only be called by draw. However, before the first ever drawing
    *   in the history of the contract, this will be called manually by the pool operator.
    * @author jmartinmcfly
   */
   // TODO: address potential gas limit issues here
  function activateEntriesInternal() internal onlyOwner {
    // update Entries
    for (uint i = 0; i < pendingAddresses.length; i++) {
      PendingEntry storage current = pendingEntries[pendingAddresses[i]];
      Entry storage currentActive = activeEntries[current.addr];
      currentActive.amount = FixidityLib.add(current.amount, currentActive.amount);
      currentActive.ticketCount = currentActive.ticketCount + current.ticketCount;
      //clear the pendingEntry
      current.amount = FixidityLib.newFixed(0);
      current.ticketCount = 0;
      // update sortition tree entry
      sortitionSumTrees.set(SUM_TREE_KEY, uint256(FixidityLib.fromFixed(currentActive.amount)), bytes32(uint256(current.addr)));
    }

    delete pendingAddresses;
  }

  event NetTotalWinnings(int theThings);

  /**
   * @notice Updates the payouts of all activeEntries in the winning group (entry.totalWinnings).
   *  Also updates unclaimedWinnings to reflect the new set of winners,
   *  Effectively resetting the prize pool.
   * @param _winningAddress The address of the winning entry
   * @author jmartinmcfly
  */
  function updatePayouts(address _winningAddress) internal returns (int256) {
    int totalWinningsFixed;
    // determine group of address
    Entry storage winner = activeEntries[_winningAddress];
    // TODO: hacky, change group structure later
    finalAmount = FixidityLib.newFixed(int(moneyMarket.balanceOfUnderlying(address(this))));
    int256 totalMinusUnclaimedPrizes = FixidityLib.subtract(finalAmount, unclaimedWinnings);
    emit TotalWinnings(FixidityLib.fromFixed(finalAmount));
    emit TotalWinnings(FixidityLib.fromFixed(principleAmount));
    emit TotalWinnings(FixidityLib.fromFixed(FixidityLib.subtract(totalMinusUnclaimedPrizes, principleAmount)));
    if (winner.groupId == -1) {
      // winner gets the whole shebang
      totalWinningsFixed = netWinningsFixedPoint24();
      emit NetTotalWinnings(FixidityLib.fromFixed(totalWinningsFixed));
      // reset prize pool
      unclaimedWinnings = FixidityLib.add(unclaimedWinnings, totalWinningsFixed);
      winner.totalWinnings = FixidityLib.add(winner.totalWinnings, totalWinningsFixed);
    } else {
      Group storage winningGroupFull = groups[uint(winner.groupId)];
      // calc total tickets
      int totalTickets = 0;
      for (uint i = 0; i < winningGroupFull.members.length; i++) {
        totalTickets = totalTickets + activeEntries[winningGroupFull.members[i]].ticketCount;
      }
      // get the total winnings from the drawing (minus the fee)
      totalWinningsFixed = netWinningsFixedPoint24();
      emit NetTotalWinnings(FixidityLib.fromFixed(totalWinningsFixed));
      // reset prize pool
      unclaimedWinnings = FixidityLib.add(unclaimedWinnings, totalWinningsFixed);
      // update payouts of all activeEntries in the group
      for (uint i = 0; i < winningGroupFull.members.length; i++) {
        Entry storage entryToChange = activeEntries[winningGroupFull.members[i]];
        int proportion = FixidityLib.newFixedFraction(entryToChange.ticketCount, totalTickets);
        int winningsCut = FixidityLib.multiply(proportion, totalWinningsFixed);
        entryToChange.totalWinnings = FixidityLib.add(entryToChange.totalWinnings, winningsCut);
      }
    }

    return totalWinningsFixed;
  }

  /**
   * @notice Transfers a users deposit, and potential winnings, back to them.
   * The Pool must be unlocked.
   * The user must have deposited funds.  Fires the Withdrawn event.
   */
  function withdraw(int _numTickets) public hasEntry {
    require(_hasEntry(msg.sender), "entrant exists");
    Entry storage entry = activeEntries[msg.sender];
    PendingEntry storage pendingEntry = pendingEntries[msg.sender];
    require(_numTickets <= (entry.ticketCount + pendingEntry.ticketCount), "You don't have that many tickets to withdraw!");
    int256 prizeToWithdraw = FixidityLib.newFixed(0);

    // if user has winnings add winnings to the withdrawal and clear their
    // winnings + decrease unclaimed winnings
    if (FixidityLib.fromFixed(entry.totalWinnings) != 0) {
      prizeToWithdraw = FixidityLib.add(prizeToWithdraw, entry.totalWinnings);
      // we have now withdrawn all winnings
      entry.totalWinnings = FixidityLib.newFixed(0);
      unclaimedWinnings = FixidityLib.subtract(unclaimedWinnings, prizeToWithdraw);
    }
    // then withdraw tickets
    int256 numTicketsFixed = FixidityLib.newFixed(_numTickets);

    int256 principleToWithdraw = FixidityLib.multiply(numTicketsFixed, ticketPrice);

    if (pendingEntry.ticketCount > 0) {
      if (_numTickets <= pendingEntry.ticketCount) {
        pendingEntry.amount = FixidityLib.subtract(pendingEntry.amount, principleToWithdraw);
        pendingEntry.ticketCount = pendingEntry.ticketCount - _numTickets;
      } else {
        int256 amountLeft = FixidityLib.subtract(principleToWithdraw, pendingEntry.amount);
        int256 ticketsLeft = _numTickets - pendingEntry.ticketCount;
        pendingEntry.amount = FixidityLib.newFixed(0);
        pendingEntry.ticketCount = 0;
        // update entry
        entry.amount = FixidityLib.subtract(entry.amount, amountLeft);
        entry.ticketCount = entry.ticketCount - ticketsLeft;
        // update sum tree to reflect withdrawn principle
        sortitionSumTrees.set(SUM_TREE_KEY, uint256(entry.amount), bytes32(uint256(msg.sender)));
      }
    } else {
      entry.amount = FixidityLib.subtract(entry.amount, principleToWithdraw);
      entry.ticketCount = entry.ticketCount - _numTickets;
      // update sum tree to reflect withdrawn principle
      sortitionSumTrees.set(SUM_TREE_KEY, uint256(entry.amount), bytes32(uint256(msg.sender)));
    }
    emit TotalWinnings(FixidityLib.fromFixed(principleToWithdraw));
    emit TotalWinnings(FixidityLib.fromFixed(prizeToWithdraw));
    // calculate total withdrawal amount
    int256 totalToWithdraw = FixidityLib.add(prizeToWithdraw, principleToWithdraw);
    int256 totalToWithdrawNonFixed = FixidityLib.fromFixed(totalToWithdraw);
    int256 remainingTickets = entry.ticketCount;
    emit Withdrawn(msg.sender, totalToWithdrawNonFixed, remainingTickets);
    // withdraw given amount from compound contract
    require(moneyMarket.redeemUnderlying(uint256(totalToWithdrawNonFixed)) == 0, "could not redeem from compound");
    require(token.transfer(msg.sender, uint256(totalToWithdrawNonFixed)), "could not transfer winnings");
  }

  function calculateWinner() private view returns (address) {
    if (principleAmount > 0) {
      return address(uint256(sortitionSumTrees.draw(SUM_TREE_KEY, randomToken())));
    } else {
      return address(0);
    }
  }

  /**
   * @notice Selects and returns the winner's address
   * @return The winner's address
   */
  function winnerAddress() public view returns (address) {
    return winningAddress;
  }

  /**
   * @notice Computes the total winnings for the drawing (interest - fee)
   * @return the total winnings as a fixed point 24
   */
  function netWinningsFixedPoint24() internal view returns (int256) {
    return FixidityLib.subtract(grossWinningsFixedPoint24(), feeAmountFixedPoint24());
  }

  /**
   * @notice Computes the total interest earned on the pool as a fixed point 24.
   * This is what the winner will earn once the pool is unlocked.
   * @return The total interest earned on the pool as a fixed point 24.
   */
  function grossWinningsFixedPoint24() internal view returns (int256) {
    int256 totalMinusUnclaimedPrizes = FixidityLib.subtract(finalAmount, unclaimedWinnings);
    return FixidityLib.subtract(totalMinusUnclaimedPrizes, principleAmount);
  }

  /**
   * @notice Calculates the size of the fee based on the gross winnings
   * @return The fee for the pool to be transferred to the owner
   */
  function feeAmount() public view returns (uint256) {
    return uint256(FixidityLib.fromFixed(feeAmountFixedPoint24()));
  }

  /**
   * @notice Calculates the fee for the pool by multiplying the gross winnings by the fee fraction.
   * @return The fee for the pool as a fixed point 24
   */
  function feeAmountFixedPoint24() internal view returns (int256) {
    return FixidityLib.multiply(grossWinningsFixedPoint24(), feeFraction);
  }

  /**
   * @notice Selects a random number in the range from [0, total tokens deposited)
   * @return If the current block is before the end it returns 0, otherwise it returns the random number.
   */
  function randomToken() public view returns (uint256) {
    return _selectRandom(uint256(FixidityLib.fromFixed(principleAmount)));
  }

  /**
   * @notice Selects a random number in the range [0, total)
   * @param total The upper bound for the random number
   * @return The random number
   */
  function _selectRandom(uint256 total) internal view returns (uint256) {
    return UniformRandomNumber.uniform(_entropy(), total);
  }

  /**
   * @notice Computes the entropy used to generate the random number.
   * The blockhash of the lock end block is XOR'd with the secret revealed by the owner.
   * @return The computed entropy value
   */
  function _entropy() internal view returns (uint256) {
    return uint256(blockhash(block.number - 1) ^ secret);
  }

  /**
   * @notice Retrieves information about the pool.
   * @return A tuple containing:
   *    entryTotal (the total of all deposits)
   *    startBlock (the block after which the pool can be locked)
   *    endBlock (the block after which the pool can be unlocked)
   *    poolState (either OPEN, LOCKED, COMPLETE)
   *    winner (the address of the winner)
   *    supplyBalanceTotal (the total deposits plus any interest from Compound)
   *    ticketCost (the cost of each ticket in DAI)
   *    participantCount (the number of unique purchasers of tickets)
   *    maxPoolSize (the maximum theoretical size of the pool to prevent overflow)
   *    estimatedInterestFixedPoint18 (the estimated total interest percent for this pool)
   *    hashOfSecret (the hash of the secret the owner submitted upon locking)
   */
  function getInfo() public view returns (
    int256 entryTotal,
    address winner,
    int256 supplyBalanceTotal,
    int256 ticketCost,
    uint256 participantCount,
    int256 maxPoolSize,
    int256 estimatedInterestFixedPoint18,
    bytes32 hashOfSecret
  ) {
    return (
      FixidityLib.fromFixed(principleAmount),
      winningAddress,
      FixidityLib.fromFixed(finalAmount),
      FixidityLib.fromFixed(ticketPrice),
      entryCount,
      FixidityLib.fromFixed(maxPoolSizeFixedPoint24(FixidityLib.maxFixedDiv())),
      FixidityLib.fromFixed(currentInterestFractionFixedPoint24(), uint8(18)),
      secretHash
    );
  }

  /**
   * @notice Retrieves information about a user's entry in the Pool.
   * @return Returns a tuple containing:
   *    addr (the address of the user)
   *    username
   *    amount (the amount they deposited)
   *    ticketCount (the number of tickets they have bought)
   *    totalWinnings (total unwithdrawn winnings of the user. Doesn't count principle)
   *    groupId (the id of the user's group)
   */
  function getEntry(address _addr) public view returns (
    address addr,
    string memory username,
    int256 amount,
    int256 ticketCount,
    int256 totalWinnings,
    int256 groupId
  ) {
    Entry storage entry = activeEntries[_addr];
    //emit TotalWinnings(entry.totalWinnings);
    //emit TotalWinnings(FixidityLib.fromFixed(entry.totalWinnings));
    return (
      entry.addr,
      entry.username,
      FixidityLib.fromFixed(entry.amount),
      entry.ticketCount,
      FixidityLib.fromFixed(entry.totalWinnings),
      entry.groupId
    );
  }

  /**
   * @notice Retrieves information about a user's entry in the Pool.
   * @return Returns a tuple containing:
   *    addr (the address of the user)
   *    username
   *    amount (the amount they deposited)
   *    ticketCount (the number of tickets they have bought)
   *    totalWinnings (total unwithdrawn winnings of the user. Doesn't count principle)
   *    groupId (the id of the user's group)
   */
  function getEntryByUsername(string calldata theUsername) external view returns (
    address addr,
    string memory username,
    int256 amount,
    int256 ticketCount,
    int256 totalWinnings,
    int256 groupId
  ) {
    Entry storage entry = activeEntries[users[theUsername]];
    return (
      entry.addr,
      entry.username,
      FixidityLib.fromFixed(entry.amount),
      entry.ticketCount,
      FixidityLib.fromFixed(entry.totalWinnings),
      entry.groupId
    );
  }

  /**
   * @notice Retrieves information about a user's pending entry in the Pool.
   * @return Returns a tuple containing:
   *    addr (the address of the user)
   *    amount (the amount they deposited)
   *    ticketCount (the number of tickets they have bought)
   */
  function getPendingEntry(address _addr) public view returns (
    address addr,
    int256 amount,
    int256 ticketCount
  ) {
    PendingEntry storage pending = pendingEntries[_addr];
    return (
      pending.addr,
      FixidityLib.fromFixed(pending.amount),
      pending.ticketCount
    );
  }

  /**
   * @notice Calculates the maximum pool size so that it doesn't overflow after earning interest
   * @dev poolSize = totalDeposits + totalDeposits * interest => totalDeposits = poolSize / (1 + interest)
   * @return The maximum size of the pool to be deposited into the money market
   */
  function maxPoolSizeFixedPoint24(int256 _maxValueFixedPoint24) public view returns (int256) {
    /// Double the interest rate in case it increases over the lock period.  Somewhat arbitrarily.
    int256 interestFraction = FixidityLib.multiply(currentInterestFractionFixedPoint24(), FixidityLib.newFixed(2));
    return FixidityLib.divide(_maxValueFixedPoint24, FixidityLib.add(interestFraction, FixidityLib.newFixed(1)));
  }

  /**
   * @notice Estimates the current effective interest rate using the money market's current supplyRateMantissa and the lock duration in blocks.
   * @return The current estimated effective interest rate
   */
  // TODO: Add intelligent / enforced blockDuration
  function currentInterestFractionFixedPoint24() public view returns (int256) {
    // Chose a duration of one week
    // arbitrary and not enforced by the contract at all
    int256 blocksPerDay = 5760;
    int256 daysPerDrawing = 7;
    int256 blockDuration = blocksPerDay * daysPerDrawing;
    // TODO: CHANGE THIS
    blockDuration = 10;
    int256 supplyRateMantissaFixedPoint24 = FixidityLib.newFixed(int256(supplyRateMantissa()), uint8(18));
    return FixidityLib.multiply(supplyRateMantissaFixedPoint24, FixidityLib.newFixed(blockDuration));
  }

  /**
   * @notice Extracts the supplyRateMantissa value from the money market contract
   * @return The money market supply rate per block
   */
  function supplyRateMantissa() public view returns (uint256) {
    return moneyMarket.supplyRatePerBlock();
  }

  /**
   * @notice Determines whether a given address has bought tickets
   * @param _addr The given address
   * @return Returns true if the given address bought tickets, false otherwise.
   */
  function _hasEntry(address _addr) internal view returns (bool) {
    return activeEntries[_addr].addr == _addr;
  }

  event AddressMatch(address daBoy);
  event AddressMatchBool(bool isAMatch);

  /**
   * @notice Determines whether a given address has bought tickets
   * @param _addr The given address
   * @return Returns true if the given address bought tickets, false otherwise.
   */
  function _hasPendingEntry(address _addr) internal returns (bool) {
    emit AddressMatch(pendingEntries[_addr].addr);
    emit AddressMatch(_addr);
    emit AddressMatchBool(pendingEntries[_addr].addr == _addr);
    return pendingEntries[_addr].addr == _addr;
  }
}
