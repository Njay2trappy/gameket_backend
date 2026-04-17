export const usersTypeDefs = `#graphql
  type StoreDetails {
    storeId: ID!
    storeName: String!
    isActive: Boolean!
    isPromoted: Boolean!
    type: String!
    totalSales: Int!
    positiveReviews: Int!
    negativeReviews: Int!
  }

  type UserDetailsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
  }

  type GetStoreDetailsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
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
    user: User
    premium: PremiumDetails
  }

  extend type Query {
    getUserDetails: UserDetailsResponse!
    getUserStoreDetails: GetStoreDetailsResponse!
    getPremium: GetPremiumResponse!
  }

  extend type Mutation {
    buyPremium: GetPremiumResponse!
  }
`;
