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

  type MerchantFundsStatus {
    lockAmount: Float!
    lockedAt: String
    unlocksAt: String
    canUnfreeze: Boolean!
  }

  type MerchantActionResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    store: StoreDetails
    wallet: Wallet
    merchantFunds: MerchantFundsStatus
    pendingOrders: Int
  }

  type MerchantCredentials {
    apiKey: String
    secret: String
  }

  type GetMerchantDetailsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    store: StoreDetails
    wallet: Wallet
    merchantFunds: MerchantFundsStatus
    merchantCredentials: MerchantCredentials
    pendingOrders: Int
  }

  input UpdateMerchantDetailsInput {
    regenerateApiKey: Boolean
    regenerateSecret: Boolean
  }

  type UpdateMerchantDetailsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    store: StoreDetails
    merchantCredentials: MerchantCredentials
  }

  type AddStoreImageResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    store: StoreDetails
    imgurl: String
  }

  extend type Query {
    getUserDetails: UserDetailsResponse!
    getUserStoreDetails: GetStoreDetailsResponse!
    getPremium: GetPremiumResponse!
    getMerchantDetails: GetMerchantDetailsResponse!
  }

  extend type Mutation {
    buyPremium: GetPremiumResponse!
    updateDeliveryOption(option: DeliveryOption!): UpdateDeliveryOptionResponse!
    UpdateMerchantdetails(input: UpdateMerchantDetailsInput!): UpdateMerchantDetailsResponse!
    addStoreImage(image: String!): AddStoreImageResponse!
    becomeMerchant: MerchantActionResponse!
    UnfreezeMerchantfunds: MerchantActionResponse!
  }
`;
