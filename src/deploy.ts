/**
 * Deploys the ProxyCaller and its accompanying Echo target contract on Massa
 * Buildnet, then runs an end-to-end test of the relay flow.
 *
 * Run with:
 *
 *   npm run deploy
 *
 * The script reads PRIVATE_KEY from the environment (.env file) and uses that
 * account to fund deployments and to pay for relayed calls.
 *
 * ProxyCaller is permissionless: there is no admin. To prove this, the script
 * relays one user call from the main funded account and a second user call from
 * a *freshly generated, independent* account (funded with a small transfer).
 * The signing "user" is a separate ephemeral key with zero MAS — it only
 * authorizes calls by signing, it never sends operations itself.
 */

import 'dotenv/config';
import {
  Account,
  Args,
  JsonRpcProvider,
  Mas,
  PrivateKey,
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
 * Build the request `Args` sent to `relayCall`.
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
  coins: bigint,
  label: string,
): Promise<SmartContract> {
  console.log(`[deploy] ${label}: deploying ${wasmName}…`);
  const byteCode = new Uint8Array(getScByteCode('build', wasmName));
  const contract = await SmartContract.deploy(provider, byteCode, ctorArgs, {
    coins,
  });
  console.log(`[deploy] ${label} deployed at ${contract.address}`);
  return contract;
}

const SPECULATIVE_ERROR = 3;
const FINAL_ERROR = 5;

// --------- main ------------------------------------------------------------

async function main(): Promise<void> {
  // Main funded account: pays for deployments and for the first relay.
  const payer = await Account.fromEnv();
  const provider = JsonRpcProvider.buildnet(payer);

  console.log(`[setup] payer address: ${payer.address.toString()}`);
  console.log(
    `[setup] payer balance: ${(await provider.balance()).toString()} nMAS`,
  );

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

  // 2. Deploy the ProxyCaller. No constructor arguments — it is permissionless.
  const proxy = await deployContract(
    provider,
    'main.wasm',
    new Args(),
    Mas.fromString('0.05'),
    'proxycaller',
  );

  // 3. Generate a fresh "user" key pair. The user has zero MAS — relayers pay —
  //    but it is the user that authorizes calls by signing.
  const userPriv = PrivateKey.generate();
  const userPub = await userPriv.getPublicKey();
  const userAddress = userPub.getAddress().toString();
  console.log(`[setup] user (no funds) address: ${userAddress}`);
  console.log(`[setup] user public key:        ${userPub.toString()}`);

  const innerCallCoins = Mas.fromString('0.1');

  // Helper that builds + signs a relay request for the user.
  async function makeSignedRequest(
    nonce: bigint,
    message: string,
    signWith: PrivateKey,
  ): Promise<{ param: Uint8Array; message: string }> {
    const innerArgs = new Args().addString(message).serialize();
    const callinfoBytes = buildCallInfo(
      echo.address,
      'setMessage',
      innerArgs,
      innerCallCoins,
    );
    const payloadHex = buildSignedPayload(
      chainId,
      proxy.address,
      userPub.toString(),
      nonce,
      callinfoBytes,
    );
    const sig = (await signWith.sign(strToBytes(payloadHex))).toString();
    return {
      param: buildRelayRequest(userPub.toString(), nonce, callinfoBytes, sig),
      message,
    };
  }

  // 4. Relay #1, submitted and paid by the main `payer` account.
  const msg1 = `hello via proxy (relayer #1) @ ${new Date().toISOString()}`;
  const req1 = await makeSignedRequest(1n, msg1, userPriv);
  console.log('[relay#1] sending relayCall (paid by payer)…');
  const op1 = await proxy.call('relayCall', req1.param, {
    coins: innerCallCoins,
    maxGas: 4_000_000_000n,
  });
  console.log(`[relay#1] operation id: ${op1.id}`);
  console.log(`[relay#1] speculative status: ${await op1.waitSpeculativeExecution()}`);
  for (const evt of await op1.getSpeculativeEvents()) {
    console.log(`[event] ${evt.data}`);
  }

  // Verify echo stored the signed message (keyed by the proxy, the immediate
  // caller seen by echo).
  let storedMsg = bytesToStr(
    (await echo.read('getMessage', new Args().addString(proxy.address))).value,
  );
  console.log(`[verify] echo.getMessage(proxy) = "${storedMsg}"`);
  if (storedMsg !== msg1) {
    throw new Error(`verification failed: stored="${storedMsg}", expected="${msg1}"`);
  }
  const lastCaller = bytesToStr((await echo.read('lastCaller')).value);
  if (lastCaller !== proxy.address) {
    throw new Error(
      `verification failed: echo.lastCaller="${lastCaller}", expected proxy "${proxy.address}"`,
    );
  }
  console.log('[verify] OK: relay #1 succeeded; echo saw the proxy as caller.');

  // 5. Relay #2, submitted and paid by a SECOND, independent account. This
  //    proves the contract is permissionless (no admin). We fund the new
  //    account with a small transfer from the payer.
  const relayer2 = await Account.generate();
  const provider2 = JsonRpcProvider.buildnet(relayer2);
  const proxyFrom2 = new SmartContract(provider2, proxy.address);
  console.log(`[setup] independent relayer #2 address: ${relayer2.address.toString()}`);
  console.log('[fund] funding relayer #2 with 1 MAS (waiting for final execution)…');
  const fundOp = await provider.transfer(relayer2.address, Mas.fromString('1'));
  // Wait for FINAL execution: the balance used by the next operation's
  // pre-flight balance check is the final balance, not the speculative one.
  console.log(`[fund] transfer status: ${await fundOp.waitFinalExecution()}`);
  console.log(
    `[fund] relayer #2 final balance: ${(await provider2.balance(true)).toString()} nMAS`,
  );

  const msg2 = `hello via proxy (relayer #2) @ ${new Date().toISOString()}`;
  const req2 = await makeSignedRequest(2n, msg2, userPriv);
  console.log('[relay#2] sending relayCall (paid by independent relayer #2)…');
  const op2 = await proxyFrom2.call('relayCall', req2.param, {
    coins: innerCallCoins,
    maxGas: 4_000_000_000n,
  });
  console.log(`[relay#2] operation id: ${op2.id}`);
  const st2 = await op2.waitSpeculativeExecution();
  console.log(`[relay#2] speculative status: ${st2}`);
  for (const evt of await op2.getSpeculativeEvents()) {
    console.log(`[event] ${evt.data}`);
  }
  if (st2 === SPECULATIVE_ERROR || st2 === FINAL_ERROR) {
    throw new Error('relay #2 from an independent account failed — permissionless check FAILED');
  }
  storedMsg = bytesToStr(
    (await echo.read('getMessage', new Args().addString(proxy.address))).value,
  );
  console.log(`[verify] echo.getMessage(proxy) = "${storedMsg}"`);
  if (storedMsg !== msg2) {
    throw new Error(`verification failed: stored="${storedMsg}", expected="${msg2}"`);
  }
  console.log('[verify] OK: ANYONE can relay — a second independent account relayed successfully.');

  // 6. Replay protection: re-submit relay #1 — must fail (nonce already used).
  console.log('[replay] re-submitting relay #1 — must fail with nonce error');
  let replayRejected = false;
  try {
    const opR = await proxy.call('relayCall', req1.param, {
      coins: innerCallCoins,
      maxGas: 4_000_000_000n,
    });
    const sR = await opR.waitSpeculativeExecution();
    console.log(`[replay] speculative status: ${sR}`);
    for (const evt of await opR.getSpeculativeEvents()) {
      console.log(`[replay event] ${evt.data}`);
      if (evt.data.toLowerCase().includes('nonce')) replayRejected = true;
    }
    if (sR === SPECULATIVE_ERROR || sR === FINAL_ERROR) replayRejected = true;
  } catch (e) {
    console.log(`[replay] threw as expected: ${(e as Error).message}`);
    replayRejected = true;
  }
  if (!replayRejected) {
    throw new Error('replay attack was NOT rejected — security check FAILED');
  }
  console.log('[verify] OK: replay was rejected.');

  // 7. Bad signature: request signed by a DIFFERENT key — must fail.
  console.log('[badsig] sending request signed by a different key — must fail');
  const otherPriv = PrivateKey.generate();
  const badReq = await makeSignedRequest(3n, 'should never apply', otherPriv);
  let badSigRejected = false;
  try {
    const opB = await proxy.call('relayCall', badReq.param, {
      coins: innerCallCoins,
      maxGas: 4_000_000_000n,
    });
    const sB = await opB.waitSpeculativeExecution();
    console.log(`[badsig] speculative status: ${sB}`);
    for (const evt of await opB.getSpeculativeEvents()) {
      console.log(`[badsig event] ${evt.data}`);
      if (evt.data.toLowerCase().includes('signature')) badSigRejected = true;
    }
    if (sB === SPECULATIVE_ERROR || sB === FINAL_ERROR) badSigRejected = true;
  } catch (e) {
    console.log(`[badsig] threw as expected: ${(e as Error).message}`);
    badSigRejected = true;
  }
  if (!badSigRejected) {
    throw new Error('a wrong signature was NOT rejected — security check FAILED');
  }
  console.log('[verify] OK: wrong signature was rejected.');

  // 8. Verify the on-chain nonce counter advanced to 2 for our user.
  const nonceBytes = (await proxy.read('getNonce', new Args().addString(userAddress)))
    .value;
  let storedNonce = 0n;
  for (let i = 0; i < 8 && i < nonceBytes.length; i++) {
    storedNonce |= BigInt(nonceBytes[i]) << BigInt(8 * i);
  }
  console.log(`[verify] proxy.getNonce(${userAddress}) = ${storedNonce}`);
  if (storedNonce !== 2n) {
    throw new Error(`nonce mismatch: stored=${storedNonce}, expected=2`);
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
