export const walletsTypeDefs = `#graphql
  type PaymentMethod {
    name: String!
    value: String!
    network: String!
    isActive: Boolean!
  }

  type Wallet {
    availableBalance: Float!
    suspendedBalance: Float!
    methods: [PaymentMethod!]!
  }

  input UserDepositInput {
    amount: Float!
  }

  type DepositDetails {
    amount: Float!
    fee: Float!
    totalCharged: Float!
  }

  type UserDepositResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    deposit: DepositDetails
    paymentData: String
  }

  type GetUserWalletsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    wallet: Wallet
  }

  type TransactionDetails {
    id: ID!
    type: String!
    status: String!
    method: String!
    amount: Float!
    createdAt: String!
  }

  type TransactionEdge {
    cursor: String!
    node: TransactionDetails!
  }

  type TransactionConnection {
    edges: [TransactionEdge!]!
    pageInfo: TransactionPageInfo!
  }

  type TransactionPageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
    fetchedCount: Int!
    remainingCount: Int!
  }

  type GetUserTransactionsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    transactions: TransactionConnection
  }

  extend type Query {
    getUserWallets: GetUserWalletsResponse!
    getUserTransactions(first: Int, after: String, last: Int, before: String): GetUserTransactionsResponse!
  }

  input AddWalletOptionInput {
    value: String!
  }

  type AddWalletOptionResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    method: PaymentMethod
  }

  extend type Mutation {
    userDeposit(input: UserDepositInput!): UserDepositResponse!
    addWalletOptions(input: AddWalletOptionInput!): AddWalletOptionResponse!
  }
`;
