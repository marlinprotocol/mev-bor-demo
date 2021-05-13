// ws server - relay side
const FlashbotsBundleProvider = require("@flashbots/ethers-provider-bundle").FlashbotsBundleProvider
const ethers =require("ethers")
const ethUtil = require('ethereumjs-util')
const WebSocket = require('ws')
const _ = require("lodash")
// miner pk on the private network
const FAUCET = "0x133be114715e5fe528a1b8adf36792160601a2d63ab59d1fd454275b31328791"
const DUMMY_RECEIVER = "0x1111111111111111111111111111111111111111" // address we'll send funds via bundles

const wss = new WebSocket.Server({ port: 8080 })
const simpleProvider = new ethers.providers.JsonRpcProvider("http://localhost:8545")
const flashBotsProvider = new FlashbotsBundleProvider(simpleProvider, "http://localhost:8545")
// we use the miner as a faucet for testing
const faucet = new ethers.Wallet(FAUCET, simpleProvider)
// we create a random user who will submit bundles
const user = ethers.Wallet.createRandom().connect(simpleProvider)
const bribe = ethers.utils.parseEther('0.02')

// Message sent to clients on first connection
const initMessage = {
  data: "Successfully connected to relay WS",
  type: "success"
}

// Set heartbeat
function heartbeat(){
  console.log("received: pong")
  this.isAlive = true;
}

const whitelistedAddresses = ["0x908e8902bd2018d3bf4d5a0fb42a457e1e8f1a6e"] // EAO address, 0x trimmed


// Helper functions
const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const timeoutRange = 5
const isValidTimestamp = (timestamp) => {
    const dateObj = new Date(timestamp)
    const currentTime = new Date()
    const lowerBound = new Date(currentTime.getTime() - timeoutRange *60000).getTime() // +- 5 mins UTC, to account for clock syncing
    const upperBound = new Date(currentTime.getTime() + timeoutRange *60000).getTime() // 60000 for mins => ms
    return dateObj.getTime() >= lowerBound && dateObj.getTime() <= upperBound
}

const isValidSignature = (signature, message) => {
    try{
        const messageHash = ethers.utils.arrayify(ethers.utils.id(message))
        const parsedSignature = ethUtil.fromRpcSig(signature)
        const recoveredAddress = "0x" + ethUtil.pubToAddress(ethUtil.ecrecover(messageHash, parsedSignature.v, parsedSignature.r, parsedSignature.s)).toString("hex");
        console.log(recoveredAddress)
        if(_.includes(whitelistedAddresses, recoveredAddress) && isValidTimestamp(parseInt(message)* 1000)){
            return true
        }else {
            return false
        }
    } catch (error){
        console.log(error)
        return false
    }
}

const generateTestBundle = async () => {
  console.log("Funding account.....")
  let tx =  await faucet.sendTransaction({
      to: user.address,
      value: ethers.utils.parseEther('1')
  })
  await tx.wait()
  const balance = await simpleProvider.getBalance(user.address)
  console.log("Balance:", balance.toString())
  const nonce = await user.getTransactionCount()
  const txs = [
      // some transaction
      {
          signer: user,
          transaction: {
              to: DUMMY_RECEIVER,
              value: ethers.utils.parseEther('0.05'),
              nonce: nonce,
          },
      },
      // the miner bribe
      {
          signer: user,
          transaction: {
              to: faucet.address,
              value: bribe,
              nonce: nonce + 1,
          }
      },
  ]
  console.log("Submitting bundle");
  const blk = await simpleProvider.getBlockNumber()

  const targetBlockNumber = blk + 5
  const payload = {
    data: {
      encodedTxs: await flashBotsProvider.signBundle(txs),
      blockNumber: `0x${targetBlockNumber.toString(16)}`,
      minTimestamp: 0,
      maxTimestamp: 0,
      revertingTxHashes: []
    },
    type: "bundle"
  }
  return payload
}

const checkBundle = async (payload) => {
  var timer = setInterval(async function() {
    const hash = ethers.utils.keccak256(payload.data.encodedTxs[0])
    const receipt = await simpleProvider.getTransactionReceipt(hash)
    if(receipt){ // If the tx has been mined, it returns null if pending
      clearInterval(timer) // stop the setInterval once we get a valid receipt
      const block = receipt.blockNumber
      const balanceBefore = await simpleProvider.getBalance(faucet.address, block - 1)
      const balanceAfter = await simpleProvider.getBalance(faucet.address, block)
      console.log("Miner before", balanceBefore.toString())
      console.log("Miner after", balanceAfter.toString())
      // subtract 2 for block reward
      const profit = balanceAfter.sub(balanceBefore).sub(ethers.utils.parseEther('2'))
      console.log("Profit (ETH)", ethers.utils.formatEther(profit))
      console.log("Profit equals bribe?", profit.eq(bribe))
      if(profit.eq(bribe)){
        wss.close()
      }
    } else{
      console.log("Bundle tx has not been mined yet")
    }
  }, 5000);
}

wss.on('connection', async function connection(ws, req){
  ws.isAlive = true;
  ws.on('pong', heartbeat)
  ws.on('message', message => {
    console.log("received message from ws client: " + message)
  })
  if(req.headers['x-auth-message']){
      const parsedAuthMessage = JSON.parse(req.headers['x-auth-message'])
      console.log(parsedAuthMessage)
      if(isValidSignature(parsedAuthMessage.signature, parsedAuthMessage.timestamp)){
        await sleep(1000)
        const payload = await generateTestBundle()
        ws.send(JSON.stringify(payload))
        await checkBundle(payload)
      }else{
        console.log("auth failed")
        ws.terminate()
      }
    }else {
      ws.terminate()
    }
  ws.on("close", m => {
    console.log("client closed " + m)
  })

})

// Heartbeat test to see if connection is still alive every 10 seconds
const interval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) {return ws.terminate()}
    ws.isAlive = false;
    ws.ping(()=> {console.log("sending: ping")});
  });
}, 10000);

wss.on('close', function close() {
  clearInterval(interval);
});
