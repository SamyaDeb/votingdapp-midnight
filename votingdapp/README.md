<![CDATA[<div align="center">

# 🗳️ Voting dApp — Midnight Network

**A decentralized, zero-knowledge voting application built on the Midnight blockchain.**

[![Built with Midnight](https://img.shields.io/badge/Built%20with-Midnight%20Network-6366f1?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgZmlsbD0iI2E4NTVmNyIvPjwvc3ZnPg==)](https://midnight.network)
[![License: MIT](https://img.shields.io/badge/License-MIT-10b981?style=for-the-badge)](LICENSE)
[![Smart Contract](https://img.shields.io/badge/Contract-Deployed-ef4444?style=for-the-badge)](#-deployed-smart-contract)

<br />

<img src="https://img.shields.io/badge/Compact-Smart%20Contract-a855f7?style=flat-square" alt="Compact" />
<img src="https://img.shields.io/badge/React-Frontend-61dafb?style=flat-square&logo=react" alt="React" />
<img src="https://img.shields.io/badge/Node.js-Backend-339933?style=flat-square&logo=node.js" alt="Node.js" />
<img src="https://img.shields.io/badge/TypeScript-100%25-3178c6?style=flat-square&logo=typescript" alt="TypeScript" />

</div>

---

## 📖 Project Description

**Voting dApp** is a full-stack decentralized application that enables **on-chain, privacy-preserving voting** using the [Midnight Network](https://midnight.network). It demonstrates how zero-knowledge proofs can be used to build transparent yet private governance tools on the blockchain.

The smart contract is written in **Compact** (Midnight's domain-specific language), and the frontend is a modern React application that communicates with the blockchain through a Node.js backend API server.

> **Why Midnight?** Unlike traditional blockchains where all data is public, Midnight uses zero-knowledge cryptography to protect sensitive information while still ensuring verifiability. This makes it ideal for voting, where ballot secrecy is essential.

---

## 🧠 What It Does

This dApp allows users to:

1. **🟢 Open a vote** — An admin opens a voting session on-chain  
2. **🗳️ Cast a vote** — Users vote **YES** or **NO**, and their vote is recorded on the blockchain  
3. **🔍 View results** — Real-time vote tallies are displayed with a visual progress bar  
4. **🔴 Close the vote** — The admin closes the voting session when done  
5. **🧾 Get a Transaction Hash** — Every action returns a verifiable on-chain transaction hash  

All votes are immutable and verifiable on-chain. Once a voter casts their ballot, they **cannot vote again** — the contract enforces uniqueness via a voter set.

### How It Works (Under the Hood)

```
┌─────────────┐       REST API       ┌──────────────────┐       Midnight SDK       ┌──────────────────┐
│   React UI  │  ◄──────────────►    │  Node.js Backend │  ◄──────────────────►    │  Midnight Chain  │
│  (Vite App) │    localhost:5173    │   (API Server)   │     localhost:4000       │  (Local Devnet)  │
└─────────────┘                      └──────────────────┘                          └──────────────────┘
                                              │
                                     ┌────────┴────────┐
                                     │  Wallet Facade  │
                                     │  (Shielded +    │
                                     │   Unshielded +  │
                                     │   Dust Wallet)  │
                                     └─────────────────┘
```

- The **React frontend** provides a sleek dark-mode UI for voting  
- The **Node.js backend** handles wallet management, transaction signing, and contract interaction using the Midnight SDK  
- The **Compact smart contract** enforces voting rules (open/close, one-vote-per-user, tally)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔐 **Zero-Knowledge Voting** | Built on Midnight's ZK-proof architecture for privacy |
| 🗳️ **One Vote Per User** | Smart contract enforces that each voter can only vote once |
| ⚡ **Real-Time Results** | Live vote counts with animated progress bar |
| 🧾 **Transaction Hashes** | Every vote returns a verifiable on-chain tx hash |
| 🛡️ **Admin Controls** | Open/close voting sessions with on-chain transactions |
| 🌑 **Premium Dark UI** | Modern, responsive interface with gradients & micro-animations |
| 📊 **Activity Log** | Track all actions with timestamps in a live log |
| 🔄 **Auto-Connect Wallet** | No manual wallet connection — the backend handles everything |
| 🏗️ **Full-Stack Architecture** | Clean separation between frontend, backend, and smart contract |

---

## 📜 Deployed Smart Contract

| Field | Value |
|-------|-------|
| **Contract Address** | `122c0386e9c9e6e9b5b1248d028e1f628a87c3068391d45cad4b97462bc8a592` |
| **Network** | `undeployed` (Local Devnet) |
| **Language** | Compact (Midnight DSL) |
| **Deployed At** | `2026-02-15T11:40:20.988Z` |

### Smart Contract Source (`voting.compact`)

```compact
pragma language_version >= 0.20;

import CompactStandardLibrary;

// Public state
export ledger yes_votes: Counter;
export ledger no_votes: Counter;
export ledger voters: Set<Bytes<32>>;
export ledger is_open: Boolean;

// Open voting
export circuit open_voting(): [] {
  is_open = true;
}

// Close voting
export circuit close_voting(): [] {
  is_open = false;
}

// Cast a vote: choice=true → yes, choice=false → no
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

**Circuits exposed:**
- `open_voting()` — Sets voting to open  
- `close_voting()` — Sets voting to closed  
- `vote(voter_id, choice)` — Casts a vote (YES = `true`, NO = `false`)

---

## 🚀 Getting Started

### Prerequisites

Before you begin, make sure you have:

- **Node.js** (v18 or later) — [Download here](https://nodejs.org/)
- **npm** (comes with Node.js)
- **Midnight Devnet** running locally (indexer, proof server, node)
  - Indexer: `http://127.0.0.1:8088`
  - Proof Server: `http://127.0.0.1:6300`
  - Node: `http://127.0.0.1:9944`

### Installation

**1. Clone the repository**

```bash
git clone https://github.com/your-username/voting-dapp.git
cd voting-dapp
```

**2. Install backend dependencies**

```bash
cd midnight-starter-template/counter-contract
npm install
```

**3. Install frontend dependencies**

```bash
cd ../../voting-ui
npm install
```

### Running the Application

You need **two terminal windows** — one for the backend and one for the frontend.

**Terminal 1 — Start the Backend API Server**

```bash
cd midnight-starter-template/counter-contract
npm run build
npm run server
```

Wait until you see:
```
✓ Server ready! Contract joined successfully.
```

**Terminal 2 — Start the Frontend**

```bash
cd voting-ui
npm run dev
```

**3. Open your browser**

Navigate to **[http://localhost:5173](http://localhost:5173)** — the app will auto-connect to the backend and display the voting interface.

---

## 🗂️ Project Structure

```
votingdapp/
├── README.md                              # You are here!
├── voting-ui/                             # Frontend (React + Vite)
│   ├── src/
│   │   ├── App.tsx                        # Main voting interface
│   │   ├── App.css                        # Premium dark-mode styles
│   │   └── main.tsx                       # React entry point
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
│
└── midnight-starter-template/
    └── counter-contract/                  # Smart contract + Backend
        ├── src/
        │   ├── voting.compact             # Smart contract source
        │   ├── voting-server.ts           # Backend API server
        │   ├── deploy-voting.ts           # Contract deployment script
        │   └── managed/voting/            # Compiled contract artifacts
        ├── deployment-voting.json         # Deployment details
        └── package.json
```

---

## 🔌 API Reference

The backend exposes the following REST endpoints on `http://127.0.0.1:4000`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | Check if the server is ready, returns wallet & contract info |
| `GET` | `/api/state` | Get current voting state (votes, open/closed) |
| `POST` | `/api/vote` | Cast a vote — body: `{ "choice": true/false }` |
| `POST` | `/api/open` | Open the voting session |
| `POST` | `/api/close` | Close the voting session |

### Example: Cast a Vote via cURL

```bash
curl -X POST http://127.0.0.1:4000/api/vote \
  -H "Content-Type: application/json" \
  -d '{"choice": true}'
```

**Response:**
```json
{
  "txHash": "00d810f5575734c26831aeb0f727576206d83e4bcc8d4016bf7a4e4471690ab59c",
  "choice": "yes"
}
```

---

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Smart Contract** | Compact (Midnight DSL) | On-chain voting logic with ZK proofs |
| **Backend** | Node.js + TypeScript | Wallet management & contract interaction |
| **Frontend** | React + TypeScript + Vite | Modern, responsive voting UI |
| **Blockchain** | Midnight Network | Privacy-preserving L1 blockchain |
| **Wallet SDK** | Midnight Wallet Facade | Shielded + unshielded + dust wallet management |
| **Styling** | Vanilla CSS | Custom dark-mode design with gradients |

---

## 📸 Screenshots

### Voting Interface
> A clean, dark-mode interface showing real-time vote counts, voting buttons, and admin controls.

### Features at a Glance
- 🟢 **Live voting status** (Open / Closed)
- 📊 **Visual progress bar** showing YES vs NO ratio
- 🧾 **Transaction hash** displayed after every action
- 📋 **Activity log** with timestamped entries

---

## 🤝 Contributing

Contributions are welcome! If you'd like to improve the Voting dApp:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- [Midnight Network](https://midnight.network) — For the privacy-preserving blockchain infrastructure
- [Compact Language](https://docs.midnight.network) — Midnight's smart contract DSL
- [Vite](https://vitejs.dev) — Lightning-fast frontend build tool
- [React](https://react.dev) — UI component library

---

<div align="center">

**Built with ❤️ on the Midnight Network**

*Zero-Knowledge • Decentralized • Private*

</div>
]]>
