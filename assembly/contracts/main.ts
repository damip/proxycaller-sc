/**
 * Massa "ProxyCaller" smart contract.
 *
 * The contract acts as a relayer-pays gateway: an off-chain user signs a "call
 * intent" (which target contract and function to invoke, with which arguments
 * and how many coins). A privileged relayer (the admin) submits the signed
 * intent to this contract; the contract verifies the signature, enforces
 * per-sender nonce continuity (anti-replay) and forwards the call. The native
 * return bytes of the inner call are returned as-is.
 *
 * The signed payload is bound to:
 *   - a domain separator string (`"massa-proxycaller-v1"`)
 *   - the chain id the contract is running on
 *   - the address of this proxy contract (callee)
 *   - the user public key
 *   - the user nonce
 *   - the serialized "call info" (target, function, args, coins)
 *
 * This binding prevents cross-chain, cross-contract and cross-purpose replay
 * of signatures.
 */

import {
  Address,
  Context,
  Storage,
  call,
  caller,
  callee,
  chainId,
  generateEvent,
  isSignatureValid,
  publicKeyToAddress,
  validateAddress,
} from '@massalabs/massa-as-sdk';
import {
  Args,
  bytesToString,
  bytesToU64,
  stringToBytes,
  u64ToBytes,
} from '@massalabs/as-types';

const DOMAIN_SEPARATOR: string = 'massa-proxycaller-v1';

const ADMIN_KEY: StaticArray<u8> = stringToBytes('ADMIN');

const NONCE_PREFIX: StaticArray<u8> = stringToBytes('N:');

/**
 * Builds the per-address storage key used to store the last accepted nonce.
 */
function nonceKey(addressBytes: StaticArray<u8>): StaticArray<u8> {
  const out = new StaticArray<u8>(NONCE_PREFIX.length + addressBytes.length);
  for (let i = 0; i < NONCE_PREFIX.length; i++) {
    out[i] = NONCE_PREFIX[i];
  }
  for (let i = 0; i < addressBytes.length; i++) {
    out[NONCE_PREFIX.length + i] = addressBytes[i];
  }
  return out;
}

/**
 * Hex-encodes a byte array. Used to safely pass an arbitrary-binary signed
 * payload to `isSignatureValid` (which expects a string).
 */
function bytesToHex(arr: StaticArray<u8>): string {
  let s = '';
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
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

/**
 * Constructor: stores the admin (relayer) address.
 *
 * @param binaryArgs - serialized `Args` containing one string: the admin
 *                     address.
 */
export function constructor(binaryArgs: StaticArray<u8>): void {
  assert(Context.isDeployingContract(), 'constructor can only run on deploy');
  const args = new Args(binaryArgs);
  const admin = args
    .nextString()
    .expect('constructor: missing admin address');
  assert(validateAddress(admin), 'constructor: invalid admin address');
  Storage.set(ADMIN_KEY, stringToBytes(admin));
  generateEvent('proxycaller deployed; admin=' + admin);
}

/**
 * Read-only getter for the admin address.
 */
export function getAdmin(_: StaticArray<u8>): StaticArray<u8> {
  return Storage.get(ADMIN_KEY);
}

/**
 * Read-only getter for the current nonce of a given user address.
 *
 * @param binaryArgs - serialized `Args` containing one string: the user address.
 * @returns serialized u64 (little-endian, 8 bytes); `0` if the user never
 *          relayed a call before.
 */
export function getNonce(binaryArgs: StaticArray<u8>): StaticArray<u8> {
  const args = new Args(binaryArgs);
  const addr = args.nextString().expect('getNonce: missing address');
  const key = nonceKey(stringToBytes(addr));
  if (!Storage.has(key)) {
    return u64ToBytes(0);
  }
  return Storage.get(key);
}

/**
 * Returns the canonical signed-payload string for a given relay request.
 * Useful for off-chain tooling and for tests, but also helpful as a self-
 * documenting view of the signing scheme.
 *
 * @param binaryArgs - serialized `Args` (publicKey, nonce, callinfo bytes).
 */
export function getSignedPayload(binaryArgs: StaticArray<u8>): StaticArray<u8> {
  const args = new Args(binaryArgs);
  const publicKey = args
    .nextString()
    .expect('getSignedPayload: missing publicKey');
  const nonce = args.nextU64().expect('getSignedPayload: missing nonce');
  const callinfo = args
    .nextBytes()
    .expect('getSignedPayload: missing callinfo');
  return stringToBytes(buildSignedPayload(publicKey, nonce, callinfo));
}

function buildSignedPayload(
  publicKey: string,
  nonce: u64,
  callinfo: StaticArray<u8>,
): string {
  const proxyAddr = callee().toString();
  const cid = chainId();
  const canonical = new Args()
    .add<string>(DOMAIN_SEPARATOR)
    .add<u64>(cid)
    .add<string>(proxyAddr)
    .add<string>(publicKey)
    .add<u64>(nonce)
    .add<StaticArray<u8>>(callinfo)
    .serialize();
  return bytesToHex(canonical);
}

/**
 * Relay an end-user signed call.
 *
 * Request format (`Args`):
 *   - publicKey   : string (base58check)
 *   - nonce       : u64    (must equal previous_nonce + 1)
 *   - callinfo    : bytes  (serialized `Args` containing target/function/args/coins)
 *   - signature   : string (base58check)
 *
 * The `callinfo` bytes deserialize as an `Args` containing:
 *   - targetAddress : string
 *   - functionName  : string
 *   - innerArgs     : bytes  (serialized argument bytes for the inner call)
 *   - coins         : u64    (coins to forward to the inner call)
 *
 * @returns the raw bytes returned by the inner call.
 */
export function relayCall(binaryArgs: StaticArray<u8>): StaticArray<u8> {
  const adminBytes = Storage.get(ADMIN_KEY);
  const adminStr = bytesToString(adminBytes);
  assert(
    caller().toString() == adminStr,
    'relayCall: only the admin can relay calls',
  );

  const args = new Args(binaryArgs);
  const publicKey = args.nextString().expect('relayCall: missing publicKey');
  const nonce = args.nextU64().expect('relayCall: missing nonce');
  const callinfoBytes = args
    .nextBytes()
    .expect('relayCall: missing callinfo');
  const signature = args.nextString().expect('relayCall: missing signature');

  const senderAddr = publicKeyToAddress(publicKey).toString();
  const nKey = nonceKey(stringToBytes(senderAddr));
  let prevNonce: u64 = 0;
  if (Storage.has(nKey)) {
    prevNonce = bytesToU64(Storage.get(nKey));
  }
  assert(nonce == prevNonce + 1, 'relayCall: nonce discontinuity');
  Storage.set(nKey, u64ToBytes(nonce));

  const payload = buildSignedPayload(publicKey, nonce, callinfoBytes);
  assert(
    isSignatureValid(publicKey, payload, signature),
    'relayCall: invalid signature',
  );

  const callinfo = new Args(callinfoBytes);
  const targetAddress = callinfo
    .nextString()
    .expect('relayCall: callinfo missing target');
  const functionName = callinfo
    .nextString()
    .expect('relayCall: callinfo missing function');
  const innerArgsBytes = callinfo
    .nextBytes()
    .expect('relayCall: callinfo missing args');
  const coins = callinfo.nextU64().expect('relayCall: callinfo missing coins');

  generateEvent(
    'proxycaller relay: from=' +
      senderAddr +
      ' nonce=' +
      nonce.toString() +
      ' target=' +
      targetAddress +
      ' fn=' +
      functionName +
      ' coins=' +
      coins.toString(),
  );

  const inner = new Args(innerArgsBytes);
  return call(new Address(targetAddress), functionName, inner, coins);
}
