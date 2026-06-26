/**
 * Massa "ProxyCaller" smart contract.
 *
 * The contract is a permissionless relayer-pays gateway: an end user signs a
 * "call intent" off-chain (which target contract and function to invoke, with
 * which arguments and how many coins). *Anyone* can then submit that signed
 * intent to this contract and pay its gas; the contract verifies the signature,
 * enforces per-sender nonce continuity (anti-replay) and forwards the call. The
 * native return bytes of the inner call are returned as-is.
 *
 * There is intentionally NO admin / privileged relayer: security comes entirely
 * from the user's signature plus the per-user monotonic nonce, so letting
 * anyone relay a request is safe. The relayer cannot alter the call (any change
 * invalidates the signature) nor replay it (the nonce only moves forward).
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
  callee,
  chainId,
  generateEvent,
  isSignatureValid,
  publicKeyToAddress,
} from '@massalabs/massa-as-sdk';
import {
  Args,
  bytesToU64,
  stringToBytes,
  u64ToBytes,
} from '@massalabs/as-types';

const DOMAIN_SEPARATOR: string = 'massa-proxycaller-v1';

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
 * Constructor.
 *
 * The contract is fully permissionless and holds no configuration, so the
 * constructor only guards against being re-run and emits a deploy event. It is
 * kept because the standard Massa deployer invokes `constructor` on the freshly
 * created contract.
 *
 * @param _ - unused.
 */
export function constructor(_: StaticArray<u8>): void {
  assert(Context.isDeployingContract(), 'constructor can only run on deploy');
  generateEvent('proxycaller deployed (permissionless, no admin)');
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
 * Relay an end-user signed call. Callable by anyone — the submitter pays the
 * gas, the signing user authorizes the call.
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
  const args = new Args(binaryArgs);
  const publicKey = args.nextString().expect('relayCall: missing publicKey');
  const nonce = args.nextU64().expect('relayCall: missing nonce');
  const callinfoBytes = args
    .nextBytes()
    .expect('relayCall: missing callinfo');
  const signature = args.nextString().expect('relayCall: missing signature');

  // Verify the signature first: this authenticates the request and binds it to
  // this proxy/chain/nonce/callinfo. Only then do we touch storage.
  const payload = buildSignedPayload(publicKey, nonce, callinfoBytes);
  assert(
    isSignatureValid(publicKey, payload, signature),
    'relayCall: invalid signature',
  );

  // Nonce continuity (anti-replay), keyed by the address derived from the
  // signed public key (not by the submitter).
  const senderAddr = publicKeyToAddress(publicKey).toString();
  const nKey = nonceKey(stringToBytes(senderAddr));
  let prevNonce: u64 = 0;
  if (Storage.has(nKey)) {
    prevNonce = bytesToU64(Storage.get(nKey));
  }
  assert(nonce == prevNonce + 1, 'relayCall: nonce discontinuity');
  Storage.set(nKey, u64ToBytes(nonce));

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
