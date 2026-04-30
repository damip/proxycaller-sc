/**
 * Deploys the ProxyCaller and its accompanying Echo target contract on Massa
 * Buildnet, then runs an end-to-end test of the relay flow.
 *
 * Run with:
 *
 *   npm run deploy
 *
 * The script reads PRIVATE_KEY from the environment (.env file) and uses that
 * account as both:
 *   - the funder paying for deployments and gas;
 *   - the "admin" / relayer of the ProxyCaller.
 *
 * For the actual proxied call, the script generates a fresh ephemeral key pair
 * (the "user"). The user signs a call intent locally, the relayer submits it,
 * and the script then verifies the side effects on chain.
 */

import 'dotenv/config';
import {
  Account,
  Args,
  JsonRpcProvider,
  Mas,
  PrivateKey,
  PublicKey,
  Signature,
  SmartContract,
  bytesToStr,
  strToBytes,
} from '@massalabs/massa-web3';
import { getScByteCode } from './utils';

// --------- helpers ---------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const hi = (b >>> 4) & 0xf;
    const lo = b & 0xf;
    s += hi < 10
      ? String.fromCharCode(0x30 + hi)
      : String.fromCharCode(0x57 + hi);
    s += lo < 10
      ? String.fromCharCode(0x30 + lo)
      : String.fromCharCode(0x57 + lo);
  }
  return s;
}

const DOMAIN_SEPARATOR = 'massa-proxycaller-v1';

/**
 * Build the canonical signed payload for a relay request. Must stay in sync
 * with the AssemblyScript implementation in `assembly/contracts/main.ts`.
 */
function buildSignedPayload(
  chainId: bigint,
  proxyAddress: string,
  publicKey: string,
  nonce: bigint,
  callinfoBytes: Uint8Array,
): string {
  const canonical = new Args()
    .addString(DOMAIN_SEPARATOR)
    .addU64(chainId)
    .addString(proxyAddress)
    .addString(publicKey)
    .addU64(nonce)
    .addUint8Array(callinfoBytes);
  return bytesToHex(canonical.serialize());
}

/**
 * Build a `callinfo` byte payload from its high-level fields.
 */
function buildCallInfo(
  targetAddress: string,
  functionName: string,
  innerArgs: Uint8Array,
  coins: bigint,
): Uint8Array {
  return new Args()
    .addString(targetAddress)
    .addString(functionName)
    .addUint8Array(innerArgs)
    .addU64(coins)
    .serialize();
}

/**
 * Build the request `Args` that the relayer sends to `relayCall`.
 */
function buildRelayRequest(
  publicKey: string,
  nonce: bigint,
  callinfoBytes: Uint8Array,
  signature: string,
): Uint8Array {
  return new Args()
    .addString(publicKey)
    .addU64(nonce)
    .addUint8Array(callinfoBytes)
    .addString(signature)
    .serialize();
}

async function deployContract(
  provider: JsonRpcProvider,
  wasmName: string,
  ctorArgs: Args,
  coins: Mas,
  label: string,
): Promise<SmartContract> {
  console.log(`[deploy] ${label}: compiling done; deploying ${wasmName}…`);
  const byteCode = getScByteCode('build', wasmName);
  const contract = await SmartContract.deploy(provider, byteCode, ctorArgs, {
    coins,
  });
  console.log(`[deploy] ${label} deployed at ${contract.address}`);
  return contract;
}

// --------- main ------------------------------------------------------------

async function main(): Promise<void> {
  // Account that pays for deployments + acts as the relayer.
  const relayer = await Account.fromEnv();
  const provider = JsonRpcProvider.buildnet(relayer);

  console.log(`[setup] relayer/admin address: ${relayer.address.toString()}`);
  console.log(`[setup] relayer balance: ${(await provider.balance()).toString()} nMAS`);

  const status = await provider.getNodeStatus();
  const chainId = BigInt(status.chainId);
  console.log(`[setup] connected to chainId=${chainId.toString()}`);

  // 1. Deploy the echo target contract.
  const echo = await deployContract(
    provider,
    'echo.wasm',
    new Args(),
    Mas.fromString('0.01'),
    'echo',
  );

  // 2. Deploy the ProxyCaller, with the relayer as admin.
  const proxy = await deployContract(
    provider,
    'main.wasm',
    new Args().addString(relayer.address.toString()),
    Mas.fromString('0.05'),
    'proxycaller',
  );

  // 3. Generate a fresh "user" key pair. The user has zero MAS — only the
  //    relayer pays — but it is the user that authorizes the call by signing.
  const userPriv = PrivateKey.generate();
  const userPub = await userPriv.getPublicKey();
  const userAddress = userPub.getAddress().toString();
  console.log(`[setup] user (no funds) address: ${userAddress}`);
  console.log(`[setup] user public key:        ${userPub.toString()}`);

  // 4. Build the inner call: echo.setMessage("hello via proxy"). We forward
  //    a bit of MAS to the inner call so the echo contract can pay for the
  //    storage entries it creates.
  const message = `hello via proxy @ ${new Date().toISOString()}`;
  const innerArgs = new Args().addString(message).serialize();
  const innerCallCoins = Mas.fromString('0.1');
  const callinfoBytes = buildCallInfo(
    echo.address,
    'setMessage',
    innerArgs,
    innerCallCoins,
  );

  // 5. Build the canonical signed payload and sign it with the user key.
  const nonce = 1n;
  const payloadHex = buildSignedPayload(
    chainId,
    proxy.address,
    userPub.toString(),
    nonce,
    callinfoBytes,
  );
  const signature = await userPriv.sign(strToBytes(payloadHex));
  const sigStr = signature.toString();
  console.log(`[sign] payload length (hex chars): ${payloadHex.length}`);
  console.log(`[sign] signature: ${sigStr}`);

  // 6. Submit the relay call.
  const relayParam = buildRelayRequest(
    userPub.toString(),
    nonce,
    callinfoBytes,
    sigStr,
  );
  console.log('[relay] sending relayCall…');
  const op = await proxy.call('relayCall', relayParam, {
    coins: innerCallCoins,
    maxGas: 4_000_000_000n,
  });
  console.log(`[relay] operation id: ${op.id}`);
  const status1 = await op.waitSpeculativeExecution();
  console.log(`[relay] speculative status: ${status1}`);

  const events = await op.getSpeculativeEvents();
  for (const evt of events) {
    console.log(`[event] ${evt.data}`);
  }

  // 7. Read echo storage to verify the message was set. The echo contract
  //    keys messages by the *immediate* caller — which, when going through the
  //    proxy, is the proxy contract itself.
  const storedRead = await echo.read(
    'getMessage',
    new Args().addString(proxy.address),
  );
  const storedMsg = bytesToStr(storedRead.value);
  console.log(
    `[verify] echo.getMessage("${proxy.address}") = "${storedMsg}"`,
  );
  if (storedMsg !== message) {
    throw new Error(
      `verification failed: stored="${storedMsg}", expected="${message}"`,
    );
  }
  console.log('[verify] OK: stored message matches the one signed by the user.');

  const lastCallerRead = await echo.read('lastCaller');
  const lastCaller = bytesToStr(lastCallerRead.value);
  console.log(`[verify] echo.lastCaller = ${lastCaller}`);
  if (lastCaller !== proxy.address) {
    throw new Error(
      `verification failed: echo.lastCaller="${lastCaller}", expected proxy address "${proxy.address}"`,
    );
  }
  console.log('[verify] OK: echo saw the proxy contract as immediate caller.');

  // 8. Verify nonce continuity by replaying the same signed message.
  console.log('[replay] re-submitting the same request — must fail with nonce error');
  let replayFailed = false;
  try {
    const opR = await proxy.call('relayCall', relayParam, {
      coins: Mas.fromString('0'),
      maxGas: 4_000_000_000n,
    });
    const sR = await opR.waitSpeculativeExecution();
    console.log(`[replay] speculative status: ${sR}`);
    const evR = await opR.getSpeculativeEvents();
    for (const evt of evR) {
      console.log(`[replay event] ${evt.data}`);
      if (evt.data.toLowerCase().includes('nonce')) {
        replayFailed = true;
      }
    }
    // SpeculativeError == 3 according to OperationStatus
    if (sR === 3 || sR === 5) {
      replayFailed = true;
    }
  } catch (e) {
    console.log(`[replay] threw as expected: ${(e as Error).message}`);
    replayFailed = true;
  }
  if (!replayFailed) {
    throw new Error('replay attack was NOT rejected — security check FAILED');
  }
  console.log('[verify] OK: replay was rejected.');

  // 9. Verify a wrong signature is rejected.
  console.log('[badsig] sending request signed by a DIFFERENT key — must fail');
  const otherPriv = PrivateKey.generate();
  const otherSig = (await otherPriv.sign(strToBytes(payloadHex))).toString();
  const badNonce = 2n;
  const badPayloadHex = buildSignedPayload(
    chainId,
    proxy.address,
    userPub.toString(),
    badNonce,
    callinfoBytes,
  );
  // Sign the new payload but with the WRONG key.
  const badSig = (await otherPriv.sign(strToBytes(badPayloadHex))).toString();
  const badRelayParam = buildRelayRequest(
    userPub.toString(),
    badNonce,
    callinfoBytes,
    badSig,
  );
  let badSigFailed = false;
  try {
    const opB = await proxy.call('relayCall', badRelayParam, {
      coins: Mas.fromString('0'),
      maxGas: 4_000_000_000n,
    });
    const sB = await opB.waitSpeculativeExecution();
    console.log(`[badsig] speculative status: ${sB}`);
    const evB = await opB.getSpeculativeEvents();
    for (const evt of evB) {
      console.log(`[badsig event] ${evt.data}`);
      if (evt.data.toLowerCase().includes('signature')) {
        badSigFailed = true;
      }
    }
    if (sB === 3 || sB === 5) {
      badSigFailed = true;
    }
  } catch (e) {
    console.log(`[badsig] threw as expected: ${(e as Error).message}`);
    badSigFailed = true;
  }
  if (!badSigFailed) {
    throw new Error('a wrong signature was NOT rejected — security check FAILED');
  }
  console.log('[verify] OK: wrong signature was rejected.');

  // 10. Verify on-chain nonce counter advanced for our user.
  const nonceRead = await proxy.read(
    'getNonce',
    new Args().addString(userAddress),
  );
  const nonceBytes = nonceRead.value;
  // u64 little-endian
  let storedNonce = 0n;
  for (let i = 0; i < 8 && i < nonceBytes.length; i++) {
    storedNonce |= BigInt(nonceBytes[i]) << BigInt(8 * i);
  }
  console.log(`[verify] proxy.getNonce(${userAddress}) = ${storedNonce}`);
  if (storedNonce !== nonce) {
    throw new Error(
      `nonce mismatch: stored=${storedNonce}, expected=${nonce}`,
    );
  }
  console.log('[verify] OK: stored nonce matches.');

  console.log('\nALL CHECKS PASSED');
  console.log(`proxy contract: ${proxy.address}`);
  console.log(`echo contract:  ${echo.address}`);
}

main().catch((e) => {
  console.error('deployment / e2e test FAILED');
  console.error(e);
  process.exit(1);
});
