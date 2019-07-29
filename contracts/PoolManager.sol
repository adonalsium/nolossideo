pragma solidity 0.5.0;

import "openzeppelin-eth/contracts/ownership/Ownable.sol";
import "openzeppelin-eth/contracts/math/SafeMath.sol";
import "./Pool.sol";
import "./compound/ICErc20.sol";

/**
 * @title The Pool Manager contract for PoolTogether.
 * @author Brendan Asselstine
 * @notice Creates Pools and ensures that there is only one active Pool at a time.
 */
contract PoolManager is Ownable {
  using SafeMath for uint256;

  /**
    * Emitted when a new Pool is created.
    * @param pool The address of the new Pool contract
    * @param number The index of the pool
    */
  event PoolCreated(address indexed pool, uint256 indexed number);

  /**
    * Emitted when the ticket price is changed
    * @param ticketPrice The ticket price
    */
  event TicketPriceChanged(int256 ticketPrice);

  /**
    * Emitted when the fee fraction is changed
    * @param feeFractionFixedPoint18 The new fee fraction encoded as a fixed point 18 decimal
    */
  event FeeFractionChanged(int256 feeFractionFixedPoint18);

  Pool public currentPool;

  /**
    * The Compound cToken to supply and withdraw from
    */
  ICErc20 public moneyMarket;

  /**
    * The token to use for the moneyMarket
    */
  IERC20 public token;

  /**
    * The currently active Pool
    */
  Pool[] private existingPools;

  /**
    * The ticket price in tokens to use for the next Pool
    */
  int256 public ticketPrice;

  /**
    * The owner fee fraction to use for the next Pool
    */
  int256 private feeFractionFixedPoint18;

  /**
    * The number of Pools that have been created
    */
  uint256 public poolCount;

  /**
   * @notice Initializes a new PoolManager contract.  Generally called through ZeppelinOS
   * @param _owner The owner of the PoolManager.  They are able to change settings and are set as the owner of new lotteries.
   * @param _moneyMarket The Compound Finance MoneyMarket contract to supply and withdraw tokens.
   * @param _token The token to use for the Pools
   * @param _ticketPrice The price that tickets should sell for
   * @param _feeFractionFixedPoint18 The fraction of the gross winnings that should be transferred to the owner as the fee.  Is a fixed point 18 number.
   */
  function init (
    address _owner,
    address _moneyMarket,
    address _token,
    int256 _ticketPrice,
    int256 _feeFractionFixedPoint18
  ) public initializer {
    require(_owner != address(0), "owner cannot be the null address");
    require(_moneyMarket != address(0), "money market address is zero");
    require(_token != address(0), "token address is zero");
    Ownable.initialize(_owner);
    token = IERC20(_token);
    moneyMarket = ICErc20(_moneyMarket);

    require(_token == moneyMarket.underlying(), "token does not match the underlying money market token");

    _setFeeFraction(_feeFractionFixedPoint18);
    _setTicketPrice(_ticketPrice);
  }

  /**
   * @notice Returns information about the PoolManager
   * @return A tuple containing:
   *    _currentPool (the address of the current pool),
   *    _openDurationInBlocks (the open duration in blocks to use for the next pool),
   *    _lockDurationInBlocks (the lock duration in blocks to use for the next pool),
   *    _ticketPrice (the ticket price in DAI for the next pool),
   *    _feeFractionFixedPoint18 (the fee fraction for the next pool),
   *    _poolCount (the number of pools that have been created)
   */
  function getInfo() public view returns (
    address _currentPool,
    int256 _ticketPrice,
    int256 _feeFractionFixedPoint18,
    uint256 _poolCount
  ) {
    return (
      address(currentPool),
      ticketPrice,
      feeFractionFixedPoint18,
      poolCount
    );
  }

  /**
   * @notice Creates a new Pool.  There can be no current pool, or the current pool must be complete.
   * Can only be called by the owner.
   * Fires the PoolCreated event.
   * @param _secretHash the secretHash for the first drawing
   * @return The address of the new pool
   */
  function createPool(bytes32 _secretHash) external onlyOwner returns (address) {
    currentPool = new Pool(
      moneyMarket,
      token,
      ticketPrice,
      feeFractionFixedPoint18,
      _secretHash
    );
    currentPool.initialize(owner());
    existingPools.push(currentPool);
    poolCount = poolCount.add(1);

    emit PoolCreated(address(currentPool), poolCount);

    return address(currentPool);
  }

  /**
   * @notice Sets the ticket price in DAI.
   * Fires the TicketPriceChanged event.
   * Can only be called by the owner.  Only applies to subsequent Pools.
   * @param _ticketPrice The new price for tickets.
   */
  function setTicketPrice(int256 _ticketPrice) public onlyOwner {
    _setTicketPrice(_ticketPrice);
  }

  function _setTicketPrice(int256 _ticketPrice) internal {
    require(_ticketPrice > 0, "ticket price must be greater than zero");
    ticketPrice = _ticketPrice;

    emit TicketPriceChanged(_ticketPrice);
  }

  /**
   * @notice Sets the fee fraction paid out to the Pool owner.
   * Fires the FeeFractionChanged event.
   * Can only be called by the owner. Only applies to subsequent Pools.
   * @param _feeFractionFixedPoint18 The fraction to pay out.
   * Must be between 0 and 1 and formatted as a fixed point number with 18 decimals (as in Ether).
   */
  function setFeeFraction(int256 _feeFractionFixedPoint18) public onlyOwner {
    _setFeeFraction(_feeFractionFixedPoint18);
  }

  function _setFeeFraction(int256 _feeFractionFixedPoint18) internal {
    require(_feeFractionFixedPoint18 >= 0, "fee must be zero or greater");
    require(_feeFractionFixedPoint18 <= 1000000000000000000, "fee fraction must be 1 or less");
    feeFractionFixedPoint18 = _feeFractionFixedPoint18;

    emit FeeFractionChanged(_feeFractionFixedPoint18);
  }
}
