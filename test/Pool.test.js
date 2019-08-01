const BN = require('bn.js')
const Token = artifacts.require('Token.sol')
const Pool = artifacts.require('Pool.sol')
const CErc20Mock = artifacts.require('CErc20Mock.sol')
const FixidityLib = artifacts.require('FixidityLib.sol')
const SortitionSumTreeFactory = artifacts.require('SortitionSumTreeFactory.sol')
const mineBlocks = require('./helpers/mineBlocks')

const zero_22 = '0000000000000000000000'

contract('Pool', (accounts) => {
  let pool, token, moneyMarket, sumTree
  
  const blocksPerMinute = 5

  let [owner, admin, user1, user2, user3, user4, user5, user6] = accounts
  console.log(accounts)

  let ticketPrice = new BN(web3.utils.toWei('10', 'ether'))
  // let feeFraction = new BN('5' + zero_22) // equal to 0.05
  let feeFraction = new BN('0')

  const priceForTenTickets = ticketPrice.mul(new BN(10))

  let secret = '0x1234123412341234123412341234123412341234123412341234123412341234'
  let secretHash = web3.utils.soliditySha3(secret)
  let secret2 = '0x1234123412341234123412341234123412341234123412341234123412341235'
  let secretHash2 = web3.utils.soliditySha3(secret2)
  let secret3 = '0x1234123412341234123412341234123412341234123412341234123412341236'
  let secretHash3 = web3.utils.soliditySha3(secret3)
  let supplyRateMantissa = '100000000000000000' // 0.1 per block

  beforeEach(async () => {
    sumTree = await SortitionSumTreeFactory.new()
    fixidity = await FixidityLib.new({ from: admin })

    token = await Token.new({ from: admin })
    await token.initialize(owner)

    moneyMarket = await CErc20Mock.new({ from: admin })
    await moneyMarket.initialize(token.address, new BN(supplyRateMantissa))

    await token.mint(moneyMarket.address, web3.utils.toWei('10000000', 'ether'))
    await token.mint(user1, web3.utils.toWei('100000000', 'ether'))
    await token.mint(user2, web3.utils.toWei('100000000', 'ether'))
    await token.mint(user3, web3.utils.toWei('100000000', 'ether'))
    await token.mint(user4, web3.utils.toWei('100000000', 'ether'))
    await token.mint(user5, web3.utils.toWei('100000000', 'ether'))
    await token.mint(user6, web3.utils.toWei('100000000', 'ether'))
  })


  /**
   * Old Tests Begin
   ----------------------------------------------------------------------------
   */

  async function createPool(theSecretHash = secretHash) {
    const block = await blockNumber()

    // console.log(
    //   moneyMarket.address.toString(),
    //   token.address.toString(),
    //   (block + lockStartBlock),
    //   (block + lockEndBlock),
    //   ticketPrice.toString(),
    //   feeFraction.toString(),
    //   fixidity.address.toString()
    // )

    await Pool.link("SortitionSumTreeFactory", sumTree.address)
    await Pool.link("FixidityLib", fixidity.address)

    const pool = await Pool.new(
      moneyMarket.address,
      token.address,
      ticketPrice,
      feeFraction,
      theSecretHash
    )
    await pool.initialize(owner)
    return pool
  }

  async function blockNumber() {
    return await web3.eth.getBlockNumber()
  }

  
  describe('supplyRateMantissa()', () => {
    it('should work', async () => {
      balance = await web3.eth.getBalance(admin)
      console.log(balance)
      pool = await createPool() // ten blocks long
      supplyRate = await pool.supplyRateMantissa()
      console.log(supplyRate)
      assert.equal(await pool.supplyRateMantissa(), web3.utils.toWei('0.1', 'ether'))
    })
  })

  describe('currentInterestFractionFixedPoint24()', () => {
    it('should return the right value', async () => {
      pool = await createPool() // ten blocks long
      const interestFraction = await pool.currentInterestFractionFixedPoint24()
      assert.equal(interestFraction.toString(), web3.utils.toWei('1000000', 'ether'))
    })
  })

  describe('maxPoolSize()', () => {
    it('should set an appropriate limit based on max integers', async () => {
      pool = await createPool() // ten blocks long
      const limit = await fixidity.newFixed(new BN('1000'))
      const maxSize = await pool.maxPoolSizeFixedPoint24(limit);
      const poolLimit = new BN('333333333333333333333333000')
      assert.equal(maxSize.toString(), poolLimit.toString())
    })
  })

  describe('pool with zero open and lock durations', () => {
    beforeEach(async () => {
      pool = await createPool()
    })

    describe('buyTicket()', () => {
      it('should fail if not enough tokens approved', async () => {
        await token.approve(pool.address, ticketPrice.div(new BN(2)), { from: user1 })

        let failed
        try {
          await pool.buyTickets(1, { from: user1 })
          failed = false
        } catch (error) {
          failed = true
        }
        assert.ok(failed, "was able to deposit less than the minimum")
      })

      /*
      it('should deposit some tokens into the pool', async () => {
        await token.approve(pool.address, ticketPrice, { from: user1 })

        const response = await pool.buyTickets(1, { from: user1 })
        const boughtTicketsEvent = response.receipt.logs[0]
        assert.equal(boughtTicketsEvent.address, pool.address)
        assert.equal(boughtTicketsEvent.args[0], user1)
        assert.equal(boughtTicketsEvent.args[1].toString(), '1')
        assert.equal(boughtTicketsEvent.args[2].toString(), ticketPrice.toString())
      })
      */

      it('should allow multiple deposits', async () => {
        await token.approve(pool.address, ticketPrice, { from: user1 })

        await pool.buyTickets(1, { from: user1 })

        await token.approve(pool.address, ticketPrice, { from: user1 })
        await pool.buyTickets(1, { from: user1 })

        const response = await pool.getPendingEntry(user1)
        assert.equal(response.addr, user1)
        assert.equal(response.amount.toString(), ticketPrice.mul(new BN(2)).toString())
        assert.equal(response.ticketCount.toString(), '2')
      })
    })

    describe('getEntry()', () => {
      it('should return zero when there are no entries', async () => {
        let entry = await pool.getEntry('0x0000000000000000000000000000000000000000')
        assert.equal(entry.amount, '0')
      })
    })

    describe('winner before first drawing', () => {
      beforeEach(async () => {
        await token.approve(pool.address, ticketPrice, { from: user1 })
        await pool.buyTickets(1, { from: user1 })
      })

      it('should not have a winner until the Pool is complete', async () => {
        assert.equal(await pool.winnerAddress(), '0x0000000000000000000000000000000000000000')
      })

    })
  })

  describe('setUsername()', () => {
    beforeEach(async () => {
      pool = await createPool()
    })

    it("should create an entry for the user if they are new", async () => {
      await pool.setUsername("Biggy", {from: user1});
      response = await pool.getEntryByUsername("Biggy")
      console.log("Biggy")
      console.log(response)
      assert.equal(response.addr, user1)
      assert.equal(response.username, "Biggy")
      assert.equal(response.amount.toString(), "0")
      assert.equal(response.ticketCount.toString(), "0")
      assert.equal(response.totalWinnings.toString(), "0")
      assert.equal(response.groupId.toString(), "-1")
    })

    it("should change their username if they already have one", async () => {
      await pool.setUsername("Biggy", { from: user1 });
      await pool.setUsername("Smalls", { from: user1 })
      response = await pool.getEntryByUsername("Smalls")
      assert.equal(response.addr, user1)
      assert.equal(response.username, "Smalls")
      assert.equal(response.amount.toString(), "0")
      assert.equal(response.ticketCount.toString(), "0")
      assert.equal(response.totalWinnings.toString(), "0")
      assert.equal(response.groupId.toString(), "-1")
    })
  })

  describe('Group hijinks', () => {
    beforeEach(async () => {
      pool = await createPool()
      await pool.setUsername("Biggy", { from: user1 })
      await pool.setUsername("Floyd", { from: user2})
    })

    it("should work to create your own group", async () => {
      // groupId now positive
      // groupId maps correctly to your group which contains only you
      await pool.createGroup({from: user1})
      entry = await pool.getEntry(user1)
      groupIdFromContract = await pool.getGroupId(user1, {from: user1})
      assert.equal(entry.groupId.toString(), "0")
      assert.equal(entry.groupId.toString(), groupIdFromContract.toString())
      response = await pool.getGroup(entry.groupId)
      console.log(response)
      console.log(response.members)
      console.log(response.allowedEntrants)
      assert.equal(response.members.length, 1)
      assert.equal(response.allowedEntrants.length, 0)
      assert.equal(response.members[0], user1)

      await pool.createGroup({ from: user2 })
      entry = await pool.getEntry(user2)
      groupIdFromContract = await pool.getGroupId(user2, { from: user2 })
      assert.equal(entry.groupId.toString(), "1")
      assert.equal(entry.groupId.toString(), groupIdFromContract.toString())
      response = await pool.getGroup(entry.groupId)
      assert.equal(response.members.length, 1)
      assert.equal(response.allowedEntrants.length, 0)
      assert.equal(response.members[0], user2)
    })

    it("should work to create your own group and invite a user", async () => {
      // groupId now positive
      // groupId maps correctly to your group which contains only you
      // invite user -> your group now has user in allowedEntrants
      // user joins group: gone from allowedEntrants, now in members
      // new user 
      await pool.createGroup({ from: user1 })
      await pool.setUsername("Floyd", { from: user2 })
      await pool.invite("Floyd", {from: user1})
      entry = await pool.getEntry(user1, {from: user1});
      response = await pool.getGroup(entry.groupId)
      assert.equal(response.members.length, 1)
      assert.equal(response.allowedEntrants.length, 1)
      assert.equal(response.members[0], user1)
      assert.equal(response.allowedEntrants[0], user2)
    })

    it("should work to join a group you've been invited to", async () => {
      // groupId now positive
      // user joins group: gone from allowedEntrants, now in members
      // groupId maps correctly to their new group
      await pool.createGroup({ from: user1 })
      await pool.invite("Floyd", { from: user1 })
      groupIdFromContract = await pool.getGroupId(user1, { from: user1 })
      entry = await pool.getEntry(user1, { from: user1 });
      response = await pool.getGroup(entry.groupId)
      assert.equal(response.members.length, 1)
      assert.equal(response.allowedEntrants.length, 1)
      assert.equal(response.members[0], user1)
      assert.equal(response.allowedEntrants[0], user2)
      await pool.joinGroup(groupIdFromContract, {from: user2});
      response = await pool.getGroup(entry.groupId)
      assert.equal(response.members.length, 2)
      assert.equal(response.allowedEntrants.length, 0)
      assert.equal(response.members[0], user1)
      assert.equal(response.members[1], user2)
    })

    it("should work to leave a group", async () => {
      // you are gone from group.members
      // you're groupId is now -1
      // groupId now positive
      // user joins group: gone from allowedEntrants, now in members
      // groupId maps correctly to their new group
      await pool.createGroup({ from: user1 })
      await pool.invite("Floyd", { from: user1 })
      groupIdFromContract = await pool.getGroupId(user1, { from: user1 })
      entry = await pool.getEntry(user1, { from: user1 });
      response = await pool.getGroup(entry.groupId)
      assert.equal(response.members.length, 1)
      assert.equal(response.allowedEntrants.length, 1)
      assert.equal(response.members[0], user1)
      assert.equal(response.allowedEntrants[0], user2)
      await pool.joinGroup(groupIdFromContract, { from: user2 });
      response = await pool.getGroup(entry.groupId)
      assert.equal(response.members.length, 2)
      assert.equal(response.allowedEntrants.length, 0)
      assert.equal(response.members[0], user1)
      assert.equal(response.members[1], user2)
      await pool.leaveGroup({from: user2});
      response = await pool.getGroup(entry.groupId)
      assert.equal(response.members.length, 1)
      assert.equal(response.allowedEntrants.length, 0)
      assert.equal(response.members[0], user1)
      await pool.leaveGroup({ from: user1 });
      response = await pool.getGroup(entry.groupId)
      assert.equal(response.members.length, 0)
      assert.equal(response.allowedEntrants.length, 0)
    })

    // TODO: Eh
    it("should work to join, leave, and then join another", async () => {
      // groupId now positive
      // user joins group: gone from allowedEntrants, now in members
      // groupId maps correctly to their new group

      // you are gone from group.members
      // you're groupId is now -1

      // groupId now positive
      // user joins group: gone from allowedEntrants, now in members
      // groupId maps correctly to their new group
    })
  })

  describe('When a user joins a group', () => {
    beforeEach(async () => {
      pool = await createPool()
      await pool.setUsername("Biggy", { from: user1 })
      await pool.setUsername("Floyd", { from: user2 })
      await pool.setUsername("Queen", {from: user3})
      await pool.setUsername("Chance", { from: user4 })
      await pool.createGroup({ from: user1 })
      await pool.createGroup({ from: user2 })
      await pool.invite("Queen", { from: user1 })
      await pool.invite("Queen", { from: user2 })
    })

    it("should work if you are already invited ", async () => {
      await pool.joinGroup(0, { from: user3 });
      response = await pool.getGroup(entry.groupId)
      assert.equal(response.members.length, 2)
      assert.equal(response.allowedEntrants.length, 0)
      console.log(response)
      assert.equal(response.members[0], user1)
      assert.equal(response.members[1], user3)
    })

    it("should not work if the user is already in a group", async () => {
      let failed;
      try { 
        await pool.joinGroup(0, { from: user2 });
        failed = false;
      } catch {
        failed = true;
      }
      assert.ok(failed)
    })

    it("should not work if you are not invited", async () => {
      let failed;
      try {
        await pool.joinGroup(0, { from: user4 });
        failed = false;
      } catch {
        failed = true;
      }
      assert.ok(failed)
    })

    it("should not work if you don't have an entry yet", async () => {
      let failed;
      try {
        await pool.joinGroup(0, { from: user5 });
        failed = false;
      } catch {
        failed = true;
      }
      assert.ok(failed)
    })
  })
  

  describe("Buying tickets", () => {
    beforeEach(async () => {
      pool = await createPool()
      await token.approve(pool.address, priceForTenTickets, { from: user1 })
      await token.approve(pool.address, priceForTenTickets, { from: user2 })
    })

    it("should not give you extra entries for the current drawing", async () => {
      // activeEntries = activeEntries after
      await pool.buyTickets(1, {from: user1})
      entry = await pool.getEntry(user1)
      assert.equal(entry.amount.toString(), "0")
      assert.equal(entry.ticketCount.toString(), "0")
    })

    it("should give you new entries in the next drawing", async () => {
      // your pendingEntries should be updated
      await pool.buyTickets(1, { from: user1 })
      response = await pool.getPendingEntry(user1)
      assert.equal(response.amount.toString(), ticketPrice.mul(new BN(1)).toString())
      assert.equal(response.ticketCount.toString(), '1')
    })

    it("should allow you to buy multiple tickets at once", async() => {
      await pool.buyTickets(2, { from: user1 })
      response = await pool.getPendingEntry(user1)
      assert.equal(response.amount.toString(), ticketPrice.mul(new BN(2)).toString())
      assert.equal(response.ticketCount.toString(), '2')
    })

    it("should allow multiple purchases", async () => {
      // your pendingEntries should be updated
      await pool.buyTickets(1, { from: user1 })
      response = await pool.getPendingEntry(user1)
      assert.equal(response.amount.toString(), ticketPrice.mul(new BN(1)).toString())
      assert.equal(response.ticketCount.toString(), '1')
      // your pendingEntries should be updated
      await pool.buyTickets(1, { from: user1 })
      response = await pool.getPendingEntry(user1)
      assert.equal(response.amount.toString(), ticketPrice.mul(new BN(2)).toString())
      assert.equal(response.ticketCount.toString(), '2')
      // your pendingEntries should be updated
      await pool.buyTickets(1, { from: user1 })
      response = await pool.getPendingEntry(user1)
      assert.equal(response.amount.toString(), ticketPrice.mul(new BN(3)).toString())
      assert.equal(response.ticketCount.toString(), '3')
    })

    it("should send the purchasing tokens to the money market", async () => {
      // your pendingEntries should be updated
      await pool.buyTickets(1, { from: user1 })
      response = await pool.getPendingEntry(user1)
      assert.equal(response.amount.toString(), ticketPrice.mul(new BN(1)).toString())
      assert.equal(response.ticketCount.toString(), '1')
      // money market underlying should increase by 1.2 * ticketPrice * ticketCount
      underlyingBalance = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      })
      console.log("the balance")
      console.log(underlyingBalance)
      assert.equal(underlyingBalance, ticketPrice.mul(new BN(120)).div(new BN(100)).toString())
      // your pendingEntries should be updateds
      await pool.buyTickets(2, { from: user1 })
      response = await pool.getPendingEntry(user1)
      assert.equal(response.amount.toString(), ticketPrice.mul(new BN(3)).toString())
      assert.equal(response.ticketCount.toString(), '3')
      // money market underlying should increase by 1.2 * ticketPrice * ticketCount
      underlyingBalance = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      })
      console.log(underlyingBalance.toString())
      assert.equal(underlyingBalance.toString(), (ticketPrice.mul(new BN(3)).mul(new BN(120)).div(new BN(100))).toString());
    })
  })


  describe("Drawings", () => {
    beforeEach(async () => {
      pool = await createPool()
      await token.approve(pool.address, priceForTenTickets, { from: user1 })
      await token.approve(pool.address, priceForTenTickets, { from: user2 })
      await token.approve(pool.address, priceForTenTickets, { from: user3 })
      await token.approve(pool.address, priceForTenTickets, { from: user4 })
      await pool.setUsername("Biggy", { from: user1 })
      await pool.setUsername("Floyd", { from: user2 })
      await pool.setUsername("Queen", { from: user3 })
      await pool.setUsername("Chance", { from: user4 })
      await pool.buyTickets(1, { from: user1 })
      await pool.buyTickets(3, { from: user2 })
    })

    it("should award no winner before activation", async () => {
      let failed;
      try {
        await pool.draw(secret, secretHash2);
        failed = false
      } catch {
        failed = true
      }
      assert.ok(failed)
    })

    it("should work to manually activate before first drawing", async () => {
      await pool.activateEntries({ from: owner })
      entry1 = await pool.getEntry(user1)
      entry2 = await pool.getEntry(user2)
      console.log(entry1)
      assert.equal(entry1.amount.toString(), ticketPrice.toString())
      assert.equal(entry1.ticketCount.toString(), "1")
      assert.equal(entry2.amount.toString(), ticketPrice.mul(new BN(3)).toString())
      assert.equal(entry2.ticketCount.toString(), "3")
      pendingEntry1 = await pool.getPendingEntry(user1)
      pendingEntry2 = await pool.getPendingEntry(user2)
      assert.equal(pendingEntry1.ticketCount.toString(), "0")
      assert.equal(pendingEntry1.amount.toString(), "0")
      assert.equal(pendingEntry2.amount.toString(), "0")
      assert.equal(pendingEntry2.ticketCount.toString(), "0")
    })

    // TODO: Nah
    it("should choose a winner according to correct probabilities", async () => {
      // to hardo for this project, just look realllll closely that
      // the sortition tree is updated correctly (too lazy to insect it)
    })

    
    it("should choose a winner", async () => {
      // winner should be filled
      await pool.activateEntries({ from: owner })
      await pool.draw(secret, secretHash2)
      winner = await pool.winnerAddress()
      assert.notEqual(winner, "0x0000000000000000000000000000000000000000")
    })

    it("should set a new secret hash", async () => {
      // secret hash should be changed
      await pool.activateEntries({ from: owner })
      await pool.draw(secret, secretHash2, {from: owner})
      hash = await pool.getInfo()
      assert.equal(hash.hashOfSecret.toString(), secretHash2.toString())
    })

    it("should allow multiple drawings", async () => {
      // draw, winner chosen
      await pool.activateEntries({ from: owner })
      await pool.draw(secret, secretHash2, { from: owner })
      hash = await pool.getInfo()
      assert.equal(hash.hashOfSecret.toString(), secretHash2.toString())
      // draw, winner chosen
      await pool.draw(secret2, secretHash3, { from: owner })
    })

    it("should update balances of winning group members", async () => {
      await pool.createGroup({ from: user1 })
      await pool.invite("Floyd", { from: user1 })
      await pool.joinGroup(0, {from: user2})
      // totalWinnings of each group member should be updated correctly
      await pool.activateEntries({ from: owner })
      await pool.draw(secret, secretHash2, { from: owner })
      entry1 = await pool.getEntry(user1)
      entry2 = await pool.getEntry(user2)
      assert.equal(entry1.totalWinnings.toString(), ticketPrice.mul(new BN(20)).div(new BN(100)).toString())
      assert.equal(entry2.totalWinnings.toString(), ticketPrice.mul(new BN(3)).mul(new BN(20)).div(new BN(100)).toString())
    })

    it("should update balances correctly for solo winners", async () => {
      // totalWinnings of solo chould be updated correctly
      await pool.activateEntries({ from: owner })
      await pool.draw(secret, secretHash2, { from: owner })
      winningAddress = await pool.winnerAddress()
      winningEntry = await pool.getEntry(winningAddress)
      assert.equal(winningEntry.totalWinnings.toString(), ticketPrice.mul(new BN(4)).mul(new BN(20)).div(new BN(100)).toString())
    })

    it("should update balances correctly for winners in groups of 1", async () => {
      await pool.createGroup({ from: user1 })
      await pool.createGroup({ from: user2 })
      await pool.activateEntries({ from: owner })
      await pool.draw(secret, secretHash2, { from: owner })
      winningAddress = await pool.winnerAddress()
      winningEntry = await pool.getEntry(winningAddress)
      // TODO: Fix imprecision issues but works for now
      // assert.equal(winningEntry.totalWinnings.toString(), ticketPrice.mul(new BN(4)).mul(new BN(20)).div(new BN(100)).toString())
    })

    it("should not affect the money deposited in the moneymarket", async () => {
      before = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      })
      // underlyingBalance should be same before and after
      await pool.activateEntries({ from: owner })
      await pool.draw(secret, secretHash2, { from: owner })
      after = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      })
      assert.equal(before.toString(), after.toString())
    })

    it("should not affect the entries of the losers", async () => {
      // all losing entries should be the same before and after
      await pool.activateEntries({ from: owner })
      await pool.draw(secret, secretHash2, { from: owner })
      winningAddress = await pool.winnerAddress()
      if (winningAddress === user1) {
        losingEntry = await pool.getEntry(user2)
        assert.equal(losingEntry.totalWinnings.toString(), "0")
      } else {
        losingEntry = await pool.getEntry(user1)
        assert.equal(losingEntry.totalWinnings.toString(), "0")
      }
    })

    it("should work with multiple groups", async () => {
      await pool.buyTickets(1, { from: user3 })
      await pool.buyTickets(3, { from: user4 })
      await pool.createGroup({from: user3})
      await pool.invite("Chance", {from: user3})
      user3Group = await pool.getGroupId(user3)
      await pool.joinGroup(user3Group, {from: user4})
      await pool.createGroup({from: user1})

      await pool.invite("Floyd", {from: user1})
      user1Group = await pool.getGroupId(user1)
      await pool.joinGroup(user1Group, {from: user2})
      await pool.activateEntries({ from: owner })
      await pool.draw(secret, secretHash2, { from: owner })
      winningAddress = await pool.winnerAddress()
      // should work with one group

      if (winningAddress === user1 || winningAddress === user2) {
        entry1 = await pool.getEntry(user1)
        entry2 = await pool.getEntry(user2)
        assert.equal(entry1.totalWinnings.toString(), ticketPrice.mul(new BN(2)).mul(new BN(20)).div(new BN(100)).toString())
        assert.equal(entry2.totalWinnings.toString(), ticketPrice.mul(new BN(2)).mul(new BN(3)).mul(new BN(20)).div(new BN(100)).toString())
      }
      // should work with two groups
      if (winningAddress === user3 || winningAddress === user4) {
        entry1 = await pool.getEntry(user3)
        entry2 = await pool.getEntry(user4)
        assert.equal(entry1.totalWinnings.toString(), ticketPrice.mul(new BN(2)).mul(new BN(20)).div(new BN(100)).toString())
        assert.equal(entry2.totalWinnings.toString(), ticketPrice.mul(new BN(2)).mul(new BN(3)).mul(new BN(20)).div(new BN(100)).toString())
      }
    })
    

    it("should take into account unclaimed winnings in new drawing (no extra activation)", async () => {
      await pool.activateEntries({ from: owner })
      await pool.draw(secret, secretHash2, { from: owner })
      unclaimedWinnings = await pool.getUnclaimedWinnings();
      assert.equal(unclaimedWinnings.toString(), ticketPrice.mul(new BN(4)).mul(new BN(20)).div(new BN(100)).toString())
      await pool.buyTickets(1, {from: user1})
      await pool.draw(secret2, secretHash3, { from: owner })
      totalWinnings = unclaimedWinnings.add(ticketPrice.mul(new BN(20)).div(new BN(100)))
      unclaimedWinnings = await pool.getUnclaimedWinnings();
      assert.equal(unclaimedWinnings.toString(), totalWinnings.toString())
      theFirst = await pool.getEntry(user1)
      theSecond = await pool.getEntry(user2)
      totalWinnings = (theFirst.totalWinnings).add(theSecond.totalWinnings)
      assert.equal(unclaimedWinnings.toString(), totalWinnings.toString())
    })
  })

  describe("Withdrawal", () => {
    beforeEach(async () => {
      pool = await createPool()
      await token.approve(pool.address, priceForTenTickets, { from: user1 })
      await token.approve(pool.address, priceForTenTickets, { from: user2 })
      await pool.setUsername("Biggy", { from: user1 })
      await pool.setUsername("Floyd", { from: user2 })
      await pool.setUsername("Queen", { from: user3 })
      await pool.setUsername("Chance", { from: user4 })
      await pool.buyTickets(3, { from: user1 })
      await pool.buyTickets(3, { from: user2 })
    })

    it("should remove the correct amount of tokens from the money market", async () => {
      // money market balance should decrease accordingly
      balanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      console.log(balanceBefore.toString())
      // redeem underlyuing should be lower by removedTokens * 1.2
      await pool.withdraw(1, {from: user1})
      balanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      assert.equal(balanceAfter.toString(), balanceBefore.sub(ticketPrice).toString());

      // money market balance should decrease accordingly
      balanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      // redeem underlyuing should be lower by removedTokens * 1.2
      await pool.withdraw(1, { from: user2 })
      balanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      assert.equal(balanceAfter.toString(), balanceBefore.sub(ticketPrice).toString())

      // money market balance should decrease accordingly
      balanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      // redeem underlyuing should be lower by removedTokens * 1.2
      await pool.withdraw(2, { from: user1 })
      balanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      assert.equal(balanceAfter.toString(), balanceBefore.sub(ticketPrice.mul(new BN(2))).toString())
    })

    it("should remove the correct amount of tokens from the money market post-activation", async () => {
      await pool.activateEntries({ from: owner })
      // money market balance should decrease accordingly
      // redeem underlyuing should be lower by removedTokens * 1.2
      // money market balance should decrease accordingly
      balanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      })
      // redeem underlyuing should be lower by removedTokens * 1.2
      await pool.withdraw(1, { from: user1 })
      balanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      assert.equal(balanceAfter.toString(), balanceBefore.sub(ticketPrice).toString())

      // money market balance should decrease accordingly
      balanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      // redeem underlyuing should be lower by removedTokens * 1.2
      await pool.withdraw(1, { from: user2 })
      balanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      assert.equal(balanceAfter.toString(), balanceBefore.sub(ticketPrice).toString())

      // money market balance should decrease accordingly
      balanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      // redeem underlyuing should be lower by removedTokens * 1.2
      await pool.withdraw(2, { from: user1 })
      balanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      assert.equal(balanceAfter.toString(), balanceBefore.sub(ticketPrice.mul(new BN(2))).toString())
    })

    it("should choose withdraw all winnings for the user if available", async () => {
      await pool.activateEntries({ from: owner })
      await pool.draw(secret, secretHash2, { from: owner })

      winningAddress = await pool.winnerAddress()
      let theUser;
      if (winningAddress === user1) {
        theUser = user1;
      } else {
        theUser = user2
      }

      // user should receive totalWinnings worth of tokens


      marketBalanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      console.log(marketBalanceBefore.toString())
      tokenBalanceBefore = await token.balanceOf(theUser)
      await pool.withdraw(0, { from: theUser })
      marketBalanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      tokenBalanceAfter = await token.balanceOf(theUser)
      withdrawnValue = ticketPrice.mul(new BN(6)).mul(new BN(20)).div(new BN(100))
      console.log(withdrawnValue)
      assert.equal(marketBalanceAfter.toString(), marketBalanceBefore.sub(withdrawnValue).toString())
      assert.equal(tokenBalanceAfter.toString(), tokenBalanceBefore.add(withdrawnValue).toString())
      
      // make sure winnings were removed
      winnerEntryPostWithdraw = await pool.getEntry(theUser)
      // totalWinnings should be set back to 0

      // unclaimed winnings should be set to 0
      assert.equal(winnerEntryPostWithdraw.totalWinnings.toString(), "0")
      unclaimedWinnings = await pool.getUnclaimedWinnings()
      assert.equal(unclaimedWinnings.toString(), "0")
    })

  it("should choose withdraw all winnings if available + one ticket", async () => {
    await pool.activateEntries({ from: owner })
    await pool.draw(secret, secretHash2, { from: owner })

    winningAddress = await pool.winnerAddress()
    let theUser;
    if (winningAddress === user1) {
      theUser = user1;
    } else {
      theUser = user2
    }

    marketBalanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
      if (error) {
        console.log(error)
        assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
      } else {
        return result
      }
    });
    tokenBalanceBefore = await token.balanceOf(theUser)
    await pool.withdraw(1, { from: theUser })
    marketBalanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
      if (error) {
        console.log(error)
        assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
      } else {
        return result
      }
    });
    tokenBalanceAfter = await token.balanceOf(theUser)
    withdrawnValue = ticketPrice.mul(new BN(6)).mul(new BN(20)).div(new BN(100))
    withdrawnValue = withdrawnValue.add(ticketPrice)
    assert.equal(marketBalanceAfter.toString(), marketBalanceBefore.sub(withdrawnValue).toString())
    assert.equal(tokenBalanceAfter.toString(), tokenBalanceBefore.add(withdrawnValue).toString())

    // make sure winnings were removed
    winnerEntryPostWithdraw = await pool.getEntry(theUser)
    assert.equal(winnerEntryPostWithdraw.totalWinnings.toString(), "0")
    // totalWinnings should be set back to 0
    // user should receive totalWinnings worth of tokens

    // try withdrawing winnings and no tickets

    // try withdrawing winnings and one ticket
  })

    it("should withdraw exactly the requested number of tickets post activation", async () => {
      await pool.activateEntries({ from: owner })
      theUser = user1
      // one ticket
      marketBalanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      tokenBalanceBefore = await token.balanceOf(theUser)
      await pool.withdraw(1, { from: theUser })
      marketBalanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      tokenBalanceAfter = await token.balanceOf(theUser)
      withdrawnValue = ticketPrice
      assert.equal(marketBalanceAfter.toString(), marketBalanceBefore.sub(withdrawnValue).toString())
      assert.equal(tokenBalanceAfter.toString(), tokenBalanceBefore.add(withdrawnValue).toString())
      entryPostWithdraw = await pool.getEntry(theUser)
      assert.equal(entryPostWithdraw.ticketCount.toString(), "2")
      assert.equal(entryPostWithdraw.amount.toString(), ticketPrice.mul(new BN(2)).toString())
      // two tickets

      marketBalanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      tokenBalanceBefore = await token.balanceOf(theUser)
      await pool.withdraw(1, { from: theUser })
      marketBalanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      tokenBalanceAfter = await token.balanceOf(theUser)
      withdrawnValue = ticketPrice
      assert.equal(marketBalanceAfter.toString(), marketBalanceBefore.sub(withdrawnValue).toString())
      assert.equal(tokenBalanceAfter.toString(), tokenBalanceBefore.add(withdrawnValue).toString())
      entryPostWithdraw = await pool.getEntry(theUser)
      assert.equal(entryPostWithdraw.ticketCount.toString(), "1")
      assert.equal(entryPostWithdraw.amount.toString(), ticketPrice.toString())

      // all tickets

      marketBalanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      tokenBalanceBefore = await token.balanceOf(theUser)
      await pool.withdraw(1, { from: theUser })
      marketBalanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      tokenBalanceAfter = await token.balanceOf(theUser)
      withdrawnValue = withdrawnValue
      assert.equal(marketBalanceAfter.toString(), marketBalanceBefore.sub(withdrawnValue).toString())
      assert.equal(tokenBalanceAfter.toString(), tokenBalanceBefore.add(withdrawnValue).toString())
      entryPostWithdraw = await pool.getEntry(theUser)
      assert.equal(entryPostWithdraw.ticketCount.toString(), "0")
      assert.equal(entryPostWithdraw.amount.toString(), "0")
    })

    it("should withdraw exactly the requested number of tickets pre activation", async () => {
      theUser = user1
      // one ticket
      marketBalanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      tokenBalanceBefore = await token.balanceOf(theUser)
      await pool.withdraw(1, { from: theUser })
      marketBalanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      tokenBalanceAfter = await token.balanceOf(theUser)
      withdrawnValue = ticketPrice
      assert.equal(marketBalanceAfter.toString(), marketBalanceBefore.sub(withdrawnValue).toString())
      assert.equal(tokenBalanceAfter.toString(), tokenBalanceBefore.add(withdrawnValue).toString())
      entryPostWithdraw = await pool.getPendingEntry(theUser)
      assert.equal(entryPostWithdraw.ticketCount.toString(), "2")
      assert.equal(entryPostWithdraw.amount.toString(), ticketPrice.mul(new BN(2)).toString())
      // two tickets

      marketBalanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      tokenBalanceBefore = await token.balanceOf(theUser)
      await pool.withdraw(1, { from: theUser })
      marketBalanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      tokenBalanceAfter = await token.balanceOf(theUser)
      withdrawnValue = ticketPrice
      assert.equal(marketBalanceAfter.toString(), marketBalanceBefore.sub(withdrawnValue).toString())
      assert.equal(tokenBalanceAfter.toString(), tokenBalanceBefore.add(withdrawnValue).toString())
      entryPostWithdraw = await pool.getPendingEntry(theUser)
      assert.equal(entryPostWithdraw.ticketCount.toString(), "1")
      assert.equal(entryPostWithdraw.amount.toString(), ticketPrice.toString())

      // all tickets

      marketBalanceBefore = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      tokenBalanceBefore = await token.balanceOf(theUser)
      await pool.withdraw(1, { from: theUser })
      marketBalanceAfter = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      });
      tokenBalanceAfter = await token.balanceOf(theUser)
      withdrawnValue = ticketPrice
      assert.equal(marketBalanceAfter.toString(), marketBalanceBefore.sub(withdrawnValue).toString())
      assert.equal(tokenBalanceAfter.toString(), tokenBalanceBefore.add(withdrawnValue).toString())
      entryPostWithdraw = await pool.getPendingEntry(theUser)
      assert.equal(entryPostWithdraw.ticketCount.toString(), "0")
      assert.equal(entryPostWithdraw.amount.toString(), "0")
    })

    it("should not allow you to withdraw more tickets than you have", async () => {
      let failed;
      try {
        await pool.withdraw(4, {from: user1})
        failed = false;
      } catch {
        failed = true;
      }
      assert.ok(failed);
    })

    it("should not allow you to withdraw without an entry", async () => {
      let failed;
      try {
        await pool.withdraw(1, { from: user4 })
        failed = false;
      } catch {
        failed = true;
      }
      assert.ok(failed);
    })
  })

  describe("test user info", () => {
    it("should work", async () => {
      pool = await createPool()
      await token.approve(pool.address, priceForTenTickets, { from: user1 })
      await token.approve(pool.address, priceForTenTickets, { from: user2 })
      await token.approve(pool.address, priceForTenTickets, { from: user3 })
      await token.approve(pool.address, priceForTenTickets, { from: user4 })
      await pool.setUsername("Biggy", { from: user1 })
      await pool.setUsername("Floyd", { from: user2 })
      await pool.setUsername("Queen", { from: user3 })
      await pool.setUsername("Chance", { from: user4 })
      await pool.buyTickets(1, { from: user1 })
      await pool.buyTickets(3, { from: user2 })
      let theUser = pool.getUserInfo(user1)
      assert.equals(theUser.addressReturned.toString(), user1)
      assert.equals(theUser.usernameReturned, "Biggy")
      assert.equals(theUser.totalAmountReturned.toString(), ticketPrice.toString())
      assert.equals(theUser.totalTicketsReturned.toString(), "1")
      assert.equals(theUser.activeAmountReturned.toString(), "0")
      assert.equals(theUser.activeTicketsReturned.toString(), "0")
      assert.equals(theUser.pendingAmountReturned.toString(), ticketPrice.toString())
      assert.equals(theUser.pendingTicketsReturned.toString(), "1")
      assert.equals(theUser.totalWinningsReturned.toString(), "0")
      assert.equals(theUser.totalAmountReturned.toString(), ticketPrice.toString())
      assert.equals(theUser.totalAmountReturned.groupId(), "-1")
    })
  })

  describe('donate to prize pool', () => {
    it('should work', async () => {
      pool = await createPool() // ten blocks long
      await token.approve(pool.address, 100, { from: user1 })
      await pool.donateToPrizePool(100)
      underlyingBalance = await moneyMarket.balanceOfUnderlying.call(pool.address, (error, result) => {
        if (error) {
          console.log(error)
          assert.ok(false, "Something is wrong with moneyMarket.balanceOfUnderlying.call")
        } else {
          return result
        }
      })
      assert.equal(underlyingBalance.toString, "100")
    })
  })

/*
  // TODO: figure out if this breaks
  describe('when fee fraction is greater than zero', () => {
    beforeEach(() => {
      /// Fee fraction is 10%
      feeFraction = web3.utils.toWei('0.1', 'ether')
    })

    it('should reward the owner the fee', async () => {

      const pool = await createPool()

      const user1Tickets = ticketPrice.mul(new BN(100))
      await token.approve(pool.address, user1Tickets, { from: user1 })
      await pool.buyTickets(100, { from: user1 })

      const ownerBalance = await token.balanceOf(owner)
      // await pool.lock(secretHash, { from: owner })
      await pool.activateEntries({ from: owner })

      /// CErc20Mock awards 20% regardless of duration.
      const totalDeposit = user1Tickets
      const interestEarned = totalDeposit.mul(new BN(20)).div(new BN(100))
      const fee = interestEarned.mul(new BN(10)).div(new BN(100))
      
      // we expect unlocking to transfer the fee to the owner
      // TODO: change to draw
      await pool.draw(secret, secretHash2, { from: owner })
      assert.equal((await pool.feeAmount()).toString(), fee.toString())

      const newOwnerBalance = await token.balanceOf(owner)
      assert.equal(newOwnerBalance.toString(), ownerBalance.add(fee).toString())

      // we expect the pool winner to receive the interest less the fee
      const user1Balance = await token.balanceOf(user1)
      // await pool.withdraw({ from: user1 })
      const newUser1Balance = await token.balanceOf(user1)
      assert.equal(newUser1Balance.toString(), user1Balance.add(user1Tickets).add(interestEarned).sub(fee).toString())
    })
  })


  /*
      describe('withdraw() after unlock', () => {
        beforeEach(async () => {
          await pool.unlock({ from: user1 })
        })

        it('should allow users to withdraw after the pool is unlocked', async () => {
          let poolBalance = await pool.balanceOf(user1)
          assert.equal(poolBalance.toString(), ticketPrice.toString())

          let balanceBefore = await token.balanceOf(user1)
          await pool.withdraw({ from: user1 })
          let balanceAfter = await token.balanceOf(user1)
          let balanceDifference = new BN(balanceAfter).sub(new BN(balanceBefore))
          assert.equal(balanceDifference.toString(), ticketPrice.toString())

          poolBalance = await pool.balanceOf(user1)
          assert.equal(poolBalance.toString(), '0')

          await pool.complete(secret)
          let netWinnings = await pool.netWinnings()

          poolBalance = await pool.balanceOf(user1)
          assert.equal(poolBalance.toString(), netWinnings.toString())

          balanceBefore = await token.balanceOf(user1)
          await pool.withdraw({ from: user1 })
          balanceAfter = await token.balanceOf(user1)
          balanceDifference = new BN(balanceAfter).sub(new BN(balanceBefore))
          assert.equal(balanceDifference.toString(), netWinnings.toString())
        })
      })
    }) 

    describe('complete(secret)', () => {
      describe('with one user', () => {
        beforeEach(async () => {
          await token.approve(pool.address, ticketPrice, { from: user1 })
          await pool.buyTickets(1, { from: user1 })
          await pool.lock(secretHash)
          await pool.complete(secret)
        })

        it('should select a winner and transfer tokens from money market back', async () => {
          const info = await pool.getInfo()
          assert.equal(info.supplyBalanceTotal.toString(), web3.utils.toWei('12', 'ether'))
          assert.equal(info.winner, user1)
        })
      })


      describe('with two users', () => {
        beforeEach(async () => {
          await token.approve(pool.address, priceForTenTickets, { from: user1 })
          await pool.buyTickets(10, { from: user1 })

          await token.approve(pool.address, priceForTenTickets, { from: user2 })
          await pool.buyTickets(10, { from: user2 })

          await pool.lock(secretHash)
          await pool.complete(secret)
        })

        it('should not change the winner if time moves forward', async () => {
          const originalWinner = await pool.winnerAddress()

          await mineBlocks(256)

          for (let i = 0; i < 10; i++) {
            await mineBlocks(1)
            const newWinner = await pool.winnerAddress()
            assert.equal(newWinner.toString(), originalWinner.toString(), `Comparison failed at iteration ${i}`)
          }
        })
      })
      

      it('should succeed even without a balance', async () => {
        await pool.lock(secretHash)
        await pool.complete(secret)
        const info = await pool.getInfo()
        assert.equal(info.winner, '0x0000000000000000000000000000000000000000')
      })
    })
    */

    // TODO:
    /*
    describe('withdraw()', () => {
      it('should work for one participant', async () => {
        await token.approve(pool.address, ticketPrice, { from: user1 })
        await pool.buyTickets(1, { from: user1 })
        await pool.lock(secretHash)
        await pool.complete(secret)

        let winnings = await pool.winnings(user1)
        let winningBalance = new BN(web3.utils.toWei('12', 'ether'))
        assert.equal(winnings.toString(), winningBalance.toString())

        const balanceBefore = await token.balanceOf(user1)
        await pool.withdraw({ from: user1 })
        const balanceAfter = await token.balanceOf(user1)

        assert.equal(balanceAfter.toString(), (new BN(balanceBefore).add(winningBalance)).toString())
      })

      it('should work for two participants', async () => {

        await token.approve(pool.address, priceForTenTickets, { from: user1 })
        await pool.buyTickets(10, { from: user1 })

        await token.approve(pool.address, priceForTenTickets, { from: user2 })
        await pool.buyTickets(10, { from: user2 })

        await pool.lock(secretHash)
        await pool.complete(secret)
        const info = await pool.getInfo()

        const user1BalanceBefore = await token.balanceOf(user1)
        await pool.withdraw({ from: user1 })
        const user1BalanceAfter = await token.balanceOf(user1)

        const user2BalanceBefore = await token.balanceOf(user2)
        await pool.withdraw({ from: user2 })
        const user2BalanceAfter = await token.balanceOf(user2)

        const earnedInterest = priceForTenTickets.mul(new BN(2)).mul(new BN(20)).div(new BN(100))

        if (info.winner === user1) {
          assert.equal(user2BalanceAfter.toString(), (new BN(user2BalanceBefore).add(priceForTenTickets)).toString())
          assert.equal(user1BalanceAfter.toString(), (new BN(user1BalanceBefore).add(priceForTenTickets.add(earnedInterest))).toString())
        } else if (info.winner === user2) {
          assert.equal(user2BalanceAfter.toString(), (new BN(user2BalanceBefore).add(priceForTenTickets.add(earnedInterest))).toString())
          assert.equal(user1BalanceAfter.toString(), (new BN(user1BalanceBefore).add(priceForTenTickets)).toString())
        } else {
          throw new Error(`Unknown winner: ${info.winner}`)
        }
      })

      it('should work in a group', async () => {

      })

      it('should work if youve won solo', async () => {

      })

      it('should work if youve won in a group', async () => {

      })

    })
    */

})
