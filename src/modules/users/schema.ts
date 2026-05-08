export const usersTypeDefs = `#graphql
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

  type UpdateDeliveryOptionResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
  }

  extend type Query {
    getUserDetails: UserDetailsResponse!
    getUserStoreDetails: GetStoreDetailsResponse!
    getPremium: GetPremiumResponse!
  }

  extend type Mutation {
    buyPremium: GetPremiumResponse!
    updateDeliveryOption(option: DeliveryOption!): UpdateDeliveryOptionResponse!
  }
`;
