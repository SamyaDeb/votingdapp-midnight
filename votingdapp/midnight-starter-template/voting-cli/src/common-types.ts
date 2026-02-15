import { Counter, type VotingPrivateState } from '@eddalabs/voting-contract';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import type { DeployedContract, FoundContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { ImpureCircuitId } from '@midnight-ntwrk/compact-js';

export type VotingCircuits = ImpureCircuitId<Counter.Contract<VotingPrivateState>>;

export const VotingPrivateStateId = 'votingPrivateState';

export type VotingProviders = MidnightProviders<VotingCircuits, typeof VotingPrivateStateId, VotingPrivateState>;

export type VotingContract = Counter.Contract<VotingPrivateState>;

export type DeployedVotingContract = DeployedContract<VotingContract> | FoundContract<VotingContract>;

export type UserAction = {
  increment: string | undefined;  
};

export type DerivedState = {
  readonly round: Counter.Ledger["round"];
};

export const emptyState: DerivedState = {
  round: 0n,
};
