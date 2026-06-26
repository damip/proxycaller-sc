import { Args, bytesToU64, stringToBytes } from '@massalabs/as-types';
import {
  constructor,
  getNonce,
  relayCall,
} from '../contracts/main';
import {
  changeCallStack,
  mockScCall,
  resetStorage,
  setDeployContext,
} from '@massalabs/massa-as-sdk';

// In the unit-test VM, `assembly_script_signature_verify` always returns true
// and `assembly_script_address_from_public_key` always returns this fixed
// address regardless of the public key passed in.
const MOCK_USER_ADDR = 'AU12UBnqTHDQALpocVBnkPNy7y5CndUJQTLutaVDDFgMJcq5kQiKq';

// Default contract (callee) address used by the unit-test VM. We keep this as
// the callee so the mocked datastore stays consistent while varying the caller.
const CONTRACT_ADDR = 'AS12BqZEQ6sByhRLyEuf0YbQmcF2PsDdkNNG1akBJu9XcjZA1eT';

const PUBLIC_KEY = 'P1 mock public key';
const TARGET = 'AS12Sw7ksF1eNWTAB22DDJPUHUfVvZM3ZTSfV8qD4tawHjFGbLhuF';
const INNER_RESULT: StaticArray<u8> = stringToBytes('INNER_RESULT');

function buildCallInfo(message: string): StaticArray<u8> {
  const innerArgs = new Args().add(message).serialize();
  return new Args()
    .add(TARGET)
    .add('setMessage')
    .add<StaticArray<u8>>(innerArgs)
    .add<u64>(0) // coins = 0 so the mock VM doesn't require a balance
    .serialize();
}

function buildRequest(nonce: u64, message: string): StaticArray<u8> {
  return new Args()
    .add(PUBLIC_KEY)
    .add<u64>(nonce)
    .add<StaticArray<u8>>(buildCallInfo(message))
    .add('mock-signature')
    .serialize();
}

function currentNonce(): u64 {
  const res = getNonce(new Args().add(MOCK_USER_ADDR).serialize());
  return bytesToU64(res);
}

describe('ProxyCaller', () => {
  beforeEach(() => {
    resetStorage();
    setDeployContext();
    constructor([]);
  });

  test('nonce starts at 0', () => {
    expect(currentNonce()).toBe(0);
  });

  test('relayCall forwards the inner call and returns its bytes', () => {
    mockScCall(INNER_RESULT);
    const res = relayCall(buildRequest(1, 'hello'));
    expect(res).toStrictEqual(INNER_RESULT);
    expect(currentNonce()).toBe(1);
  });

  test('nonces must be sequential', () => {
    mockScCall(INNER_RESULT);
    relayCall(buildRequest(1, 'a'));
    expect(currentNonce()).toBe(1);

    mockScCall(INNER_RESULT);
    relayCall(buildRequest(2, 'b'));
    expect(currentNonce()).toBe(2);
  });

  throws('replaying the same nonce is rejected', () => {
    mockScCall(INNER_RESULT);
    relayCall(buildRequest(1, 'a'));
    // Replaying nonce 1 must fail (nonce discontinuity).
    relayCall(buildRequest(1, 'a'));
  });

  throws('a gap in nonces is rejected', () => {
    mockScCall(INNER_RESULT);
    // First accepted nonce must be exactly 1.
    relayCall(buildRequest(2, 'a'));
  });

  test('anyone can relay (no admin restriction)', () => {
    // Set an arbitrary, unrelated caller as the operation submitter while
    // keeping the same callee (the proxy contract). There is no admin check,
    // so the relay must still succeed.
    changeCallStack(MOCK_USER_ADDR + ' , ' + CONTRACT_ADDR);
    mockScCall(INNER_RESULT);
    const res = relayCall(buildRequest(1, 'from anyone'));
    expect(res).toStrictEqual(INNER_RESULT);
  });
});
