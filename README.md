# ProxyCaller — gas-less call relayer on Massa

`ProxyCaller` is an AssemblyScript smart contract for the [Massa](https://docs.massa.network)
blockchain that lets a privileged off-chain relayer pay the gas for arbitrary
calls authorized by end users via a digital signature. End users do not need to
hold any MAS or send any operations themselves — they just sign a *call intent*
locally and hand it to the relayer.

The high-level flow is:

```
                                       ┌──────────────┐
   user signs payload ──────────────▶  │ off-chain    │
                                       │ relayer/admin│
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
- `src/deploy.ts` — a script that builds, deploys, and runs an end-to-end
  test on Massa **Buildnet**: it deploys both contracts, signs a payload with
  a fresh ephemeral key, relays it, asserts the inner call succeeded, and then
  asserts that replays and bad-signature attempts are correctly rejected.

## Build & test

```bash
npm install            # already done by the boilerplate initializer
npm run build          # compiles AssemblyScript -> build/*.wasm
npm run deploy         # builds, deploys to Buildnet, runs e2e test
```

`PRIVATE_KEY` is read from `.env`. The account it points to acts both as the
deployer and as the relayer/admin of the proxy.

## ProxyCaller ABI

### `constructor(adminAddress: string)`

Stores `adminAddress` as the only authorized relayer. Can only be called once
at deploy time (enforced by `Context.isDeployingContract()`).

### `relayCall(request: bytes) -> bytes`

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

1. Asserts that `caller() == admin`.
2. Deserializes `request`.
3. Derives the user address from `publicKey`.
4. Reads the user's last accepted nonce from storage and asserts
   `nonce == previous_nonce + 1`. Bumps the stored nonce.
5. Reconstructs the canonical signed payload (see below) and verifies the
   signature with `isSignatureValid`.
6. Deserializes `callinfo` and forwards
   `call(targetAddress, functionName, innerArgs, coins)`.
7. Returns the bytes returned by the inner call.

### `getAdmin() -> bytes`

Returns the admin address (UTF-8 encoded).

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

- **Authentication**: only `admin` can submit relays. `admin` is set once
  at deploy time and is not mutable.
- **Authorization of the inner call**: the user's signature over the canonical
  payload binds the *exact* `(target, function, args, coins)` tuple — the
  relayer cannot change a single byte of the inner call without invalidating
  the signature.
- **Replay protection**: per-user monotonic nonce, plus chainId/proxyAddr
  binding in the signed payload.
- **Coin custody**: coins flow `relayer -> proxy -> target` (the proxy never
  holds funds between relays). The user does not need any MAS.
