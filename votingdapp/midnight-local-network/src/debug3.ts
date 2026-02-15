// Debug: check wallet sync state events
async function main() {
    const ledger = await import('@midnight-ntwrk/ledger-v7');
    const hd = await import('@midnight-ntwrk/wallet-sdk-hd');
    const shielded = await import('@midnight-ntwrk/wallet-sdk-shielded');
    const dust = await import('@midnight-ntwrk/wallet-sdk-dust-wallet');
    const unshielded = await import('@midnight-ntwrk/wallet-sdk-unshielded-wallet');
    const facadeMod = await import('@midnight-ntwrk/wallet-sdk-facade');
    const rx = await import('rxjs');

    const genesisWalletSeed = Buffer.from(
        '0000000000000000000000000000000000000000000000000000000000000001', 'hex');
    const hdWallet = hd.HDWallet.fromSeed(Uint8Array.from(genesisWalletSeed));
    if (hdWallet.type !== 'seedOk') throw new Error('HDWallet fail');
    const dr = hdWallet.hdWallet.selectAccount(0)
        .selectRoles([hd.Roles.Zswap, hd.Roles.NightExternal, hd.Roles.Dust])
        .deriveKeysAt(0);
    if (dr.type !== 'keysDerived') throw new Error('derive fail');
    hdWallet.hdWallet.clear();

    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(dr.keys[hd.Roles.Zswap]);
    const dustSecretKey = ledger.DustSecretKey.fromSeed(dr.keys[hd.Roles.Dust]);
    const ks = unshielded.createKeystore(dr.keys[hd.Roles.NightExternal], 'undeployed');
    console.log('Genesis address:', ks.getBech32Address());

    const cfg = {
        networkId: 'undeployed',
        costParameters: { additionalFeeOverhead: 300_000_000_000_000_000n, feeBlocksMargin: 5 },
        relayURL: new URL('ws://localhost:9944'),
        provingServerUrl: new URL('http://localhost:6300'),
        indexerClientConnection: {
            indexerHttpUrl: 'http://localhost:8088/api/v3/graphql',
            indexerWsUrl: 'ws://localhost:8088/api/v3/graphql/ws',
        },
    };

    const sw = shielded.ShieldedWallet(cfg as any).startWithSecretKeys(shieldedSecretKeys);
    const dw = dust.DustWallet(cfg as any).startWithSecretKey(
        dustSecretKey, ledger.LedgerParameters.initialParameters().dust);
    const uw = unshielded.UnshieldedWallet({
        ...cfg,
        txHistoryStorage: new unshielded.InMemoryTransactionHistoryStorage(),
    } as any).startWithPublicKey(unshielded.PublicKey.fromKeyStore(ks));

    const wf = new facadeMod.WalletFacade(sw, uw, dw);
    await wf.start(shieldedSecretKeys, dustSecretKey);
    console.log('Facade started, subscribing to state...');

    // Subscribe to state and log each event for 60 seconds
    let eventCount = 0;
    const sub = wf.state().pipe(
        rx.tap((s: any) => {
            eventCount++;
            const bal = s.unshielded?.balances?.[ledger.nativeToken().raw] ?? 'N/A';
            const shieldBal = s.shielded?.balances?.[ledger.nativeToken().raw] ?? 'N/A';
            console.log(`[${eventCount}] isSynced=${s.isSynced}, unshielded_bal=${bal}, shielded_bal=${shieldBal}`);
        }),
        rx.takeUntil(rx.timer(60000)),
    ).subscribe({
        complete: () => {
            console.log(`Done after ${eventCount} events in 60s`);
            wf.stop().then(() => process.exit(0));
        },
        error: (err: any) => {
            console.error('State error:', err);
            wf.stop().then(() => process.exit(1));
        },
    });
}

main().catch(e => {
    console.error('ERROR:', e);
    process.exit(1);
});
