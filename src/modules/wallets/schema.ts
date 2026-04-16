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

  extend type Query {
    getUserWallets: GetUserWalletsResponse!
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
