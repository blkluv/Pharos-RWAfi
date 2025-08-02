const fs = require('fs');
const { ethers } = require('ethers');
const { EthersWallet } = require('ethersjs3-wallet');
const axios = require('axios');

const RPC_URL = 'https://testnet.dplabs-internal.com';
const CONTRACT_ADDRESS = '0xcc8cf44e196cab28dba2d514dc7353af0efb370e';
const CLAIMTOKENS_ABI = [
  "function claimTokens() public"
];

const API_LOGIN = 'https://api.aquaflux.pro/api/v1/users/wallet-login';
const API_SIGNATURE = 'https://api.aquaflux.pro/api/v1/users/get-signature';

const privateKeys = fs.readFileSync('pk.txt', 'utf-8')
  .split('\n')
  .map(line => line.trim())
  .filter(line => line.length > 0);

// Số lần lặp cho mỗi tài khoản (có thể chỉnh ở đây)
const numRounds = 100; // <-- Chỉnh số lần chạy cho mỗi acc ở đây
const wallet = new EthersWallet();

const provider = new ethers.JsonRpcProvider(RPC_URL);

// Hàm xử lý cho 1 lần chạy của 1 tài khoản
async function processAccount(pk, round, numRounds) {
  try {
    const wallet = new ethers.Wallet(pk, provider);
    const address = await wallet.getAddress();
    // 1. Đăng nhập ví
    const now = Date.now();
    const message = `Sign in to AquaFlux with timestamp: ${now}`;
    const signature = await wallet.signMessage(message);
    const loginRes = await axios.post(API_LOGIN, {
      address,
      message,
      signature
    });
    const accessToken = loginRes.data.data.accessToken;
    console.log(`[Round ${round+1}/${numRounds}] Login success for ${address}`);

    // 2. Thực hiện claimTokens
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CLAIMTOKENS_ABI, wallet);
    const tx1 = await contract.claimTokens();
    console.log(`[Round ${round+1}/${numRounds}] claimTokens sent: ${tx1.hash}`);
    await tx1.wait();
    console.log(`[Round ${round+1}/${numRounds}] claimTokens confirmed: ${tx1.hash}`);

    // 3. Gửi raw transaction (data bạn đã có)
    const RAW_DATA = "0x7905642a0000000000000000000000000000000000000000000000056bc75e2d63100000";
    const tx2 = await wallet.sendTransaction({
      to: CONTRACT_ADDRESS,
      data: RAW_DATA,
      value: 0
    });
    console.log(`[Round ${round+1}/${numRounds}] Raw tx sent: ${tx2.hash}`);
    await tx2.wait();
    console.log(`[Round ${round+1}/${numRounds}] Raw tx confirmed: ${tx2.hash}`);

    // 4. Kiểm tra holding token
    const checkRes = await axios.post(
      'https://api.aquaflux.pro/api/v1/users/check-token-holding',
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );
    if (
      checkRes.data.status !== 'success' ||
      !checkRes.data.data?.isHoldingToken
    ) {
      throw new Error('Wallet does not hold required token!');
    }
    console.log(`[Round ${round+1}/${numRounds}] Token holding check passed for ${address}`);

    // 5. Lấy signature đặc biệt từ API
    const sigRes = await axios.post(API_SIGNATURE, {
      requestedNftType: 0,
      walletAddress: address
    }, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    const { signature: nftSignature, expiresAt } = sigRes.data.data;
    console.log(`[Round ${round+1}/${numRounds}] Got NFT signature for ${address}`);

    // 6. Gửi transaction với signature và expiresAt
    // Chuẩn bị data encode thủ công
    const functionSelector = "0x75e7e053";
    const param1 = "0000000000000000000000000000000000000000000000000000000000000000"; // 0
    const param2 = ethers.toBeHex(expiresAt, 32).replace('0x', '').padStart(64, '0');
    const param3 = "0000000000000000000000000000000000000000000000000000000000000060"; // offset 96
    const param4 = "0000000000000000000000000000000000000000000000000000000000000041"; // 65 bytes
    const sigHex = nftSignature.replace('0x', '');
    const dynamicData = sigHex.padEnd(130, '0'); // 65 bytes = 130 hex chars

    const data = functionSelector
      + param1
      + param2
      + param3
      + param4
      + dynamicData;

    const tx3 = await wallet.sendTransaction({
      to: CONTRACT_ADDRESS,
      data: data,
      value: 0
    });
    console.log(`[Round ${round+1}/${numRounds}] NFT claim tx sent: ${tx3.hash}`);
    await tx3.wait();
    console.log(`[Round ${round+1}/${numRounds}] NFT claim tx confirmed: ${tx3.hash}`);

  } catch (err) {
    console.error(`[Round ${round+1}/${numRounds}] Error with key ${pk}:`, err.response?.data || err.message);
  }
}

async function main() {
  const pLimit = (await import('p-limit')).default;
  const limit = pLimit(10); // 10 luồng song song
  for (let round = 0; round < numRounds; round++) {
    console.log(`\n===== ROUND ${round + 1} / ${numRounds} =====`);
    const tasks = privateKeys.map(pk => limit(() => processAccount(pk, round, numRounds)));
    await Promise.all(tasks);
  }
}

main();
