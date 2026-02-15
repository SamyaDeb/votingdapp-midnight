# Voting dApp — Midnight Network

<img width="1470" height="956" alt="Screenshot 2026-02-15 at 6 00 40 PM" src="https://github.com/user-attachments/assets/cd41af5f-2746-4b4d-899d-96ab3de08327" />


A decentralized, zero-knowledge voting application built on the [Midnight](https://midnight.network) blockchain using the Compact smart contract language.

---

## Deployed Contract

| Field | Value |
|-------|-------|
| **Contract Address** | `122c0386e9c9e6e9b5b1248d028e1f628a87c3068391d45cad4b97462bc8a592` |
| **Network** | Midnight Local Devnet |
| **Deployed At** | 2026-02-15 |

---

## What It Does

This dApp lets users vote on-chain with zero-knowledge privacy. The smart contract tracks yes/no votes, prevents double voting, and allows an admin to open or close voting — all enforced on-chain via Compact circuits.

**Contract capabilities:**
- `open_voting()` — Opens the voting session
- `close_voting()` — Closes the voting session
- `vote(voter_id, choice)` — Casts a yes or no vote (prevents duplicates)

**On-chain state:**
- `yes_votes` / `no_votes` — Running tallies
- `voters` — Set of voter IDs (prevents double voting)
- `is_open` — Whether voting is currently active

---

## Smart Contract

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

export ledger yes_votes: Counter;
export ledger no_votes: Counter;
export ledger voters: Set<Bytes<32>>;
export ledger is_open: Boolean;

export circuit open_voting(): [] {
  is_open = true;
}

export circuit close_voting(): [] {
  is_open = false;
}

export circuit vote(voter_id: Bytes<32>, choice: Boolean): [] {
  assert(is_open, "voting is not open");
  const disclosed_voter_id = disclose(voter_id);
  const disclosed_choice = disclose(choice);
  assert(!voters.member(disclosed_voter_id), "already voted");
  voters.insert(disclosed_voter_id);
  if (disclosed_choice) {
    yes_votes.increment(1);
  } else {
    no_votes.increment(1);
  }
}
```

---

## Project Structure

```
votingdapp/
├── midnight-local-network/          # Local devnet infrastructure
│   ├── compose.yml                  # Docker Compose (node, indexer, proof-server)
│   └── src/
│       ├── fund.ts                  # Fund wallets from genesis
│       ├── fund-and-register-dust.ts
│       ├── fund-lib.ts              # Funding library
│       └── utils.ts                 # Wallet initialization utilities
│
├── midnight-starter-template/       # Contract & CLI tooling
│   ├── voting-contract/             # Smart contract package
│   │   ├── src/
│   │   │   ├── voting.compact       # The voting contract source
│   │   │   ├── deploy-voting.ts     # Deployment script
│   │   │   └── managed/voting/      # Compiled contract & ZK keys
│   │   └── package.json
│   │
│   └── voting-cli/                  # CLI interface
│       ├── src/
│       │   ├── api.ts               # Contract interaction API
│       │   ├── cli.ts               # Interactive terminal UI
│       │   └── test/                # Integration tests
│       └── package.json
│
└── voting-ui/                       # React frontend
    ├── src/
    │   ├── App.tsx                  # Main voting UI component
    │   └── api.ts                   # Contract API client
    └── package.json
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart Contract | [Compact](https://docs.midnight.network) (zero-knowledge language) |
| Blockchain | Midnight Network (node v0.20.1) |
| Wallet SDK | `@midnight-ntwrk/wallet-sdk` v1.0.0 |
| Indexer | Midnight Indexer v3.0.0 |
| Proof Server | Proof Server v7.0.0 |
| Frontend | React + TypeScript + Vite |
| Runtime | Node.js v20 |

---

## Getting Started

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Node.js](https://nodejs.org/) v20+
- npm or bun

### 1. Start the local network

```bash
cd votingdapp/midnight-local-network
docker compose up -d
```

This starts three containers:
- **node** (port 9944) — Midnight blockchain node
- **indexer** (port 8088) — Block indexer with GraphQL API
- **proof-server** (port 6300) — ZK proof generation server

### 2. Fund a wallet

```bash
cd votingdapp/midnight-local-network
npm run fund -- <wallet-address>
```

### 3. Deploy the voting contract

```bash
cd votingdapp/midnight-starter-template/voting-contract
npm run build
npm run deploy:voting
```

The deploy script will:
1. Generate a new wallet (or accept your seed)
2. Wait for the wallet to sync and receive funds
3. Register for dust token generation
4. Deploy the voting contract on-chain
5. Output the deployed contract address

### 4. Run the frontend

```bash
cd votingdapp/voting-ui
npm install
npm run dev
```

---

## License

MIT
