/**
 * Deploys the ProxyCaller contract to a Massa network.
 *
 * Usage:
 *
 *   npm run deploy
 *
 * Configuration is read from environment variables (a local `.env` file is
 * loaded automatically):
 *
 *   PRIVATE_KEY   (required) secret key of the funded account paying for the
 *                            deployment.
 *   JSON_RPC_URL  (optional) JSON-RPC endpoint. Defaults to the public
 *                            Buildnet endpoint. Set this to a mainnet endpoint
 *                            to deploy on mainnet.
 *
 * The ProxyCaller constructor takes no arguments: the contract is
 * permissionless and holds no configuration.
 */

import 'dotenv/config';
import {
  Account,
  Args,
  JsonRpcProvider,
  Mas,
  SmartContract,
} from '@massalabs/massa-web3';
import { getScByteCode } from './utils';

async function main(): Promise<void> {
  const account = await Account.fromEnv();

  const rpcUrl = process.env.JSON_RPC_URL;
  const provider = rpcUrl
    ? JsonRpcProvider.fromRPCUrl(rpcUrl, account)
    : JsonRpcProvider.buildnet(account);

  console.log(`Deploying ProxyCaller from ${account.address.toString()}…`);

  const byteCode = new Uint8Array(getScByteCode('build', 'main.wasm'));

  const contract = await SmartContract.deploy(provider, byteCode, new Args(), {
    coins: Mas.fromString('0.05'),
  });

  console.log(`ProxyCaller deployed at: ${contract.address}`);

  for (const event of await provider.getEvents({
    smartContractAddress: contract.address,
  })) {
    console.log(`Event: ${event.data}`);
  }
}

main().catch((e) => {
  console.error('Deployment failed:');
  console.error(e);
  process.exit(1);
});
