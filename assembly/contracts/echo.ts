/**
 * Tiny "echo" contract used as a target for ProxyCaller end-to-end tests.
 *
 * It exposes:
 *   - `setMessage(string)`  : stores a message keyed by the *real* caller of
 *                             `setMessage`, returns the stored bytes.
 *   - `getMessage(string)`  : fetches the stored message for an address.
 *   - `lastCaller(_)`       : returns the address that most recently called
 *                             `setMessage`. Useful to verify that, when called
 *                             through the proxy, the immediate caller seen by
 *                             the target is the proxy contract.
 */

import {
  Context,
  Storage,
  generateEvent,
  caller,
} from '@massalabs/massa-as-sdk';
import { Args, bytesToString, stringToBytes } from '@massalabs/as-types';

const LAST_CALLER_KEY: StaticArray<u8> = stringToBytes('LAST');
const MSG_PREFIX: StaticArray<u8> = stringToBytes('M:');

function msgKey(addr: string): StaticArray<u8> {
  const a = stringToBytes(addr);
  const out = new StaticArray<u8>(MSG_PREFIX.length + a.length);
  for (let i = 0; i < MSG_PREFIX.length; i++) out[i] = MSG_PREFIX[i];
  for (let i = 0; i < a.length; i++) out[MSG_PREFIX.length + i] = a[i];
  return out;
}

export function constructor(_: StaticArray<u8>): void {
  assert(Context.isDeployingContract(), 'echo: ctor only on deploy');
  generateEvent('echo deployed');
}

export function setMessage(binaryArgs: StaticArray<u8>): StaticArray<u8> {
  const args = new Args(binaryArgs);
  const message = args
    .nextString()
    .expect('setMessage: missing message string');
  const c = caller().toString();
  Storage.set(msgKey(c), stringToBytes(message));
  Storage.set(LAST_CALLER_KEY, stringToBytes(c));
  generateEvent('echo.setMessage: caller=' + c + ' msg=' + message);
  return stringToBytes(message);
}

export function getMessage(binaryArgs: StaticArray<u8>): StaticArray<u8> {
  const args = new Args(binaryArgs);
  const addr = args.nextString().expect('getMessage: missing address');
  const k = msgKey(addr);
  if (!Storage.has(k)) {
    return stringToBytes('');
  }
  return Storage.get(k);
}

export function lastCaller(_: StaticArray<u8>): StaticArray<u8> {
  if (!Storage.has(LAST_CALLER_KEY)) {
    return stringToBytes('');
  }
  return Storage.get(LAST_CALLER_KEY);
}
