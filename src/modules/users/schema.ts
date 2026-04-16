export const usersTypeDefs = `#graphql
  type StoreDetails {
    storeId: ID!
    storeName: String!
    isActive: Boolean!
    type: String!
    totalSales: Int!
    positiveReviews: Int!
    negativeReviews: Int!
  }

  type UserDetails {
    id: ID!
    username: String!
    email: String!
    country: String!
    isActive: Boolean!
    isVerified: Boolean!
    isPremium: Boolean!
    twoFactorAuth: Boolean!
    rank: Int!
    registered: String!
    isStore: Boolean!
    avatar: String
    store: StoreDetails
    wallet: Wallet
    premium: PremiumDetails
  }

  type UserDetailsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: UserDetails
  }

  type GetStoreDetailsResponse {
    code: Int!
    success: Boolean!
    message: String!
    store: StoreDetails
  }

  type PremiumDetails {
    subscribedAt: String!
    expiresAt: String!
    isActive: Boolean!
  }

  type GetPremiumResponse {
    code: Int!
    success: Boolean!
    message: String!
    premium: PremiumDetails
  }

  extend type Query {
    getUserDetails: UserDetailsResponse!
    getStoreDetails: GetStoreDetailsResponse!
    getPremium: GetPremiumResponse!
  }

  extend type Mutation {
    buyPremium: GetPremiumResponse!
  }
`;
