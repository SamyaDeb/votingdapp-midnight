// Quick test - just imports and key derivation, no wallet connections
async function main() {
    console.log('STEP 1: start');
    
    const ledger = await import('@midnight-ntwrk/ledger-v7');
    console.log('STEP 2: ledger imported');
    
    const hd = await import('@midnight-ntwrk/wallet-sdk-hd');
    console.log('STEP 3: hd imported');

    const genesisWalletSeed = Buffer.from(
        '0000000000000000000000000000000000000000000000000000000000000001',
        'hex',
    );
    const hdWallet = hd.HDWallet.fromSeed(Uint8Array.from(genesisWalletSeed));
    if (hdWallet.type !== 'seedOk') throw new Error('HDWallet fail');
    const dr = hdWallet.hdWallet.selectAccount(0)
        .selectRoles([hd.Roles.Zswap, hd.Roles.NightExternal, hd.Roles.Dust])
        .deriveKeysAt(0);
    if (dr.type !== 'keysDerived') throw new Error('derive fail');
    hdWallet.hdWallet.clear();
    console.log('STEP 4: keys derived');

    const unshielded = await import('@midnight-ntwrk/wallet-sdk-unshielded-wallet');
    const ks = unshielded.createKeystore(dr.keys[hd.Roles.NightExternal], 'undeployed');
    console.log('STEP 5: genesis address:', ks.getBech32Address());
    
    // Now try creating wallets
    const shielded = await import('@midnight-ntwrk/wallet-sdk-shielded');
    const dust = await import('@midnight-ntwrk/wallet-sdk-dust-wallet');
    const facadeMod = await import('@midnight-ntwrk/wallet-sdk-facade');
    console.log('STEP 6: all imports done');

    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(dr.keys[hd.Roles.Zswap]);
    const dustSecretKey = ledger.DustSecretKey.fromSeed(dr.keys[hd.Roles.Dust]);

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

    console.log('STEP 7: creating shielded wallet...');
    const sw = shielded.ShieldedWallet(cfg as any).startWithSecretKeys(shieldedSecretKeys);
    console.log('STEP 8: shielded wallet created');

    console.log('STEP 9: creating dust wallet...');
    const dw = dust.DustWallet(cfg as any).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
    );
    console.log('STEP 10: dust wallet created');

    console.log('STEP 11: creating unshielded wallet...');
    const uw = unshielded.UnshieldedWallet({
        ...cfg,
        txHistoryStorage: new unshielded.InMemoryTransactionHistoryStorage(),
    } as any).startWithPublicKey(unshielded.PublicKey.fromKeyStore(ks));
    console.log('STEP 12: unshielded wallet created');

    console.log('STEP 13: creating facade...');
    const wf = new facadeMod.WalletFacade(sw, uw, dw);
    console.log('STEP 14: calling facade.start()...');
    
    await wf.start(shieldedSecretKeys, dustSecretKey);
    console.log('STEP 15: facade started');
    
    const rx = await import('rxjs');
    const state = await rx.firstValueFrom(
        wf.state().pipe(rx.filter((s: any) => s.isSynced))
    );
    console.log('STEP 16: synced, balance:', state.unshielded?.balances[ledger.nativeToken().raw] ?? 0n);

    await wf.stop();
    process.exit(0);
}

main().catch(e => {
    console.error('ERROR:', e);
    process.exit(1);
});
