import { Credential } from 'mppx'
import { Mppx as Mppx_client, evm as evm_client } from 'mppx/client'
import { Mppx, evm } from 'mppx/server'
import { erc20Abi } from 'viem'
import { waitForTransactionReceipt, writeContract } from 'viem/actions'
import { describe, expect, test } from 'vp/test'
import { realm, secretKey, useChargeAnvil } from '~test/evm/charge.js'

describe('EVM Permit2 charge verifier', () => {
  const anvil = useChargeAnvil()

  test('creates fresh default nonces and preserves nonce overrides', async () => {
    const server = createServer()
    const client = createClient()
    const challenge = await server.charge({ expires: anvil.expires() })(
      new Request('https://api.example.com/resource'),
    )
    expect(challenge.status).toBe(402)
    if (challenge.status !== 402) throw new Error('Expected an EVM charge challenge.')

    const first = permit2Payload(await client.createCredential(challenge.challenge))
    const second = permit2Payload(await client.createCredential(challenge.challenge))

    expect(first.permit.nonce).toMatch(/^[1-9]\d*$/)
    expect(second.permit.nonce).toMatch(/^[1-9]\d*$/)
    expect(second.permit.nonce).not.toBe(first.permit.nonce)

    const explicit = createClient({ permit2: { nonce: 123n } })
    expect(permit2Payload(await explicit.createCredential(challenge.challenge)).permit.nonce).toBe(
      '123',
    )
  })

  test('settles using ERC-20 approval and rejects replay', async () => {
    const { fixture } = anvil
    const before = await anvil.balanceOf(fixture.token, fixture.recipient.address)
    const server = createServer()
    const client = createClient()
    await approvePermit2(2_000_000n)

    const { authorization, receipt } = await anvil.settle({ client, server })

    expect(receipt.reference).toMatch(/^0x[0-9a-f]{64}$/i)
    await expect(anvil.balanceOf(fixture.token, fixture.recipient.address)).resolves.toBe(
      before + 1_000_000n,
    )

    const replay = await server.charge({ expires: anvil.expires() })(
      new Request('https://api.example.com/resource', {
        headers: { Authorization: authorization },
      }),
    )
    expect(replay.status).toBe(402)
  })

  test('does not consume a credential when ERC-20 approval is insufficient', async () => {
    const { fixture } = anvil
    const before = await anvil.balanceOf(fixture.token, fixture.recipient.address)
    const server = createServer()
    const client = createClient()
    await approvePermit2(0n)

    const challenge = await server.charge({ expires: anvil.expires() })(
      new Request('https://api.example.com/resource'),
    )
    expect(challenge.status).toBe(402)
    if (challenge.status !== 402) throw new Error('Expected an EVM charge challenge.')

    const authorization = await client.createCredential(challenge.challenge)
    const rejected = await server.charge({ expires: anvil.expires() })(
      new Request('https://api.example.com/resource', {
        headers: { Authorization: authorization },
      }),
    )
    expect(rejected.status).toBe(402)

    await approvePermit2(1_000_000n)
    const settled = await server.charge({ expires: anvil.expires() })(
      new Request('https://api.example.com/resource', {
        headers: { Authorization: authorization },
      }),
    )
    expect(settled.status).toBe(200)
    if (settled.status !== 200) throw new Error('Expected retry to settle.')
    await expect(anvil.balanceOf(fixture.token, fixture.recipient.address)).resolves.toBe(
      before + 1_000_000n,
    )
  })

  function createServer() {
    const { fixture } = anvil
    return Mppx.create({
      methods: [
        evm({
          account: fixture.deployer,
          amount: '1',
          chainId: fixture.chain.id,
          credentialTypes: ['permit2'],
          currency: fixture.token,
          decimals: 6,
          getClient: () => fixture.serverClient,
          permit2Address: fixture.permit2,
          recipient: fixture.recipient.address,
          spender: fixture.deployer.address,
        }),
      ],
      realm,
      secretKey,
    })
  }

  function createClient(options: { permit2?: { nonce: bigint } } = {}) {
    const { fixture } = anvil
    return Mppx_client.create({
      methods: [
        evm_client({
          account: fixture.payer,
          credentialType: 'permit2',
          getClient: () => fixture.payerClient,
          permit2: options.permit2,
        }),
      ],
      polyfill: false,
    })
  }

  async function approvePermit2(amount: bigint) {
    const { fixture } = anvil
    const hash = await writeContract(fixture.payerClient, {
      abi: erc20Abi,
      account: fixture.payer,
      address: fixture.token,
      args: [fixture.permit2, amount],
      chain: fixture.chain,
      functionName: 'approve',
    })
    await waitForTransactionReceipt(fixture.publicClient, { hash })
  }
})

function permit2Payload(authorization: string) {
  const credential = Credential.deserialize<any>(authorization)
  expect(credential.payload.type).toBe('permit2')
  return credential.payload as {
    permit: { nonce: string }
    type: 'permit2'
  }
}
