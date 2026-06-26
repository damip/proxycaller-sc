# ProxyCaller — permissionless gas-less call relayer on Massa

`ProxyCaller` is an AssemblyScript smart contract for the [Massa](https://docs.massa.network)
blockchain that lets **anyone** pay the gas for arbitrary calls authorized by
end users via a digital signature. End users do not need to hold any MAS or send
any operations themselves — they just sign a *call intent* locally and hand it to
any relayer willing to submit (and pay for) it.

There is **no admin and no privileged relayer**: security comes entirely from the
user's signature plus a per-user monotonic nonce, so letting anyone relay a
request is safe. A relayer cannot tamper with the call (any change invalidates
the signature) nor replay it (the nonce only moves forward).

The high-level flow is:

```
                                       ┌──────────────┐
   user signs payload ──────────────▶  │ any off-chain │
                                       │   relayer     │
                                       └──────┬───────┘
                                              │ CallSC(relayCall, request)
                                              ▼
                                       ┌──────────────┐
                                       │ ProxyCaller  │  verifies signature,
                                       │  contract    │  bumps user nonce,
                                       └──────┬───────┘  forwards inner call
                                              │ call(target, fn, args, coins)
                                              ▼
                                       ┌──────────────┐
                                       │  any target  │
                                       │   contract   │
                                       └──────────────┘
```

## What's in here

- `assembly/contracts/main.ts` — the `ProxyCaller` smart contract.
- `assembly/contracts/echo.ts` — a tiny target contract used as an
  end-to-end test target.
- `assembly/__tests__/proxycaller.spec.ts` — AS-pect unit tests.
- `src/deploy.ts` — a script that builds, deploys, and runs an end-to-end
  test on Massa **Buildnet**: it deploys both contracts, then signs a payload
  with a fresh ephemeral user key and relays it. It proves the contract is
  permissionless by relaying a second call from a *different, independent*
  account, and asserts that replays and bad-signature attempts are rejected.

## Build & test

```bash
npm install            # already done by the boilerplate initializer
npm run build          # compiles AssemblyScript -> build/*.wasm
npm test               # runs the AS-pect unit tests
npm run deploy         # builds, deploys to Buildnet, runs e2e test
```

`PRIVATE_KEY` is read from `.env`. The account it points to funds the
deployments and pays for the relayed calls in the e2e test (but note that *any*
account can relay — the contract enforces no caller restriction).

## ProxyCaller ABI

### `constructor()`

Takes no arguments. The contract is permissionless and holds no configuration,
so the constructor only guards against being re-run (via
`Context.isDeployingContract()`) and emits a deploy event.

### `relayCall(request: bytes) -> bytes`

Callable by **anyone**. The submitter pays the gas; the signing user authorizes
the call.

`request` is a serialized `Args` containing in order:

| field       | type     | notes                                   |
| ----------- | -------- | --------------------------------------- |
| `publicKey` | `string` | base58check, identifies the user        |
| `nonce`     | `u64`    | must equal `previous_nonce + 1`         |
| `callinfo`  | `bytes`  | serialized inner-call info (see below)  |
| `signature` | `string` | base58check, signs the canonical bytes  |

`callinfo` is itself a serialized `Args`:

| field            | type     |
| ---------------- | -------- |
| `targetAddress`  | `string` |
| `functionName`   | `string` |
| `innerArgs`      | `bytes`  |
| `coins`          | `u64`    |

`relayCall` performs:

1. Deserializes `request`.
2. Reconstructs the canonical signed payload (see below) and verifies the
   signature with `isSignatureValid`. This authenticates the request *before*
   any state is touched.
3. Derives the user address from `publicKey`.
4. Reads the user's last accepted nonce from storage and asserts
   `nonce == previous_nonce + 1`. Bumps the stored nonce.
5. Deserializes `callinfo` and forwards
   `call(targetAddress, functionName, innerArgs, coins)`.
6. Returns the bytes returned by the inner call.

Note: because Massa reverts all state changes when an execution aborts, an
invalid signature or a bad nonce reverts the whole call atomically (including
the nonce bump), so the ordering of the signature/nonce checks is safe either
way; the signature is checked first as a matter of good practice.

### `getNonce(addr: string) -> bytes`

Returns the last accepted nonce for `addr` as 8-byte little-endian `u64`,
or 0 if the address never relayed a call.

### `getSignedPayload(publicKey, nonce, callinfo) -> bytes`

Convenience getter returning the canonical signed payload (UTF-8 hex) for a
given request. Useful for debugging / off-chain tooling.

## Canonical signed payload

To prevent cross-chain, cross-contract and cross-purpose replay of a single
signed payload, the user signs over a deterministic serialization that binds
the request to:

| field             | rationale                                 |
| ----------------- | ----------------------------------------- |
| `"massa-proxycaller-v1"` | fixed domain separator              |
| `chainId`         | binds to the Massa network                |
| `proxyAddress`    | binds to this specific proxy contract     |
| `publicKey`       | identifies the user                       |
| `nonce`           | replay protection                         |
| `callinfo`        | the actual call intent                    |

These are serialized using the standard `Args` (length-prefixed) format and
the resulting bytes are hex-encoded. The hex string is what is fed to
`isSignatureValid` (and that the user signs). Hex is used so the binary
payload can survive a `string` round-trip through the WASM ABI without
hitting UTF-8 invalid sequences.

## Security model

- **No admin / permissionless**: `relayCall` has no caller restriction. Anyone
  can submit a signed request and pay its gas. This is safe because each request
  is independently authenticated by the user's signature and protected from
  replay by the per-user nonce.
- **Authorization of the inner call**: the user's signature over the canonical
  payload binds the *exact* `(target, function, args, coins)` tuple — a relayer
  cannot change a single byte of the inner call without invalidating the
  signature.
- **Replay protection**: per-user monotonic nonce, plus chainId/proxyAddr
  binding in the signed payload.
- **Coin custody**: coins flow `relayer -> proxy -> target` (the proxy never
  holds funds between relays). The user does not need any MAS.
