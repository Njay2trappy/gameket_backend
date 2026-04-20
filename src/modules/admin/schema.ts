export const adminTypeDefs = `#graphql
  input AdminLoginInput {
    email: String!
    password: String!
  }

  type AdminLoginResponse {
    code: Int!
    success: Boolean!
    message: String!
    token: String
  }

  input SupportLoginInput {
    email: String!
    password: String!
  }

  type SupportLoginResponse {
    code: Int!
    success: Boolean!
    message: String!
    token: String
    support: SupportAccountDetails
  }

  enum AdminStatsFilter {
    DAY
    WEEK
    MONTH
    ALL
  }

  type AdminSiteStats {
    totalRevenue: Float!
    totalOrders: Int!
    totalRegisteredUsers: Int!
    totalProducts: Int!
    totalSellers: Int!
    premiumUsers: Int!
    totalProductsSold: Int!
    totalTransactions: Int!
  }

  type AdminGetDetailsResponse {
    code: Int!
    success: Boolean!
    message: String!
    stats: AdminSiteStats
  }

  type AdminTransactionNode {
    userId: String!
    id: ID!
    type: String!
    status: String!
    method: String!
    amount: Float!
    createdAt: String!
  }

  type AdminTransactionEdge {
    cursor: String!
    node: AdminTransactionNode!
  }

  type AdminTransactionConnection {
    edges: [AdminTransactionEdge!]!
    pageInfo: AdminPageInfo!
  }

  type AdminPageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
    fetchedCount: Int!
    remainingCount: Int!
  }

  type AdminUserEdge {
    cursor: String!
    node: User!
  }

  type AdminUserConnection {
    edges: [AdminUserEdge!]!
    pageInfo: AdminPageInfo!
  }

  type AdmingetUsersResponse {
    code: Int!
    success: Boolean!
    message: String!
    users: AdminUserConnection!
  }

  type AdmingetBuyersResponse {
    code: Int!
    success: Boolean!
    message: String!
    buyers: AdminUserConnection!
  }

  type AdmingetStoresResponse {
    code: Int!
    success: Boolean!
    message: String!
    stores: AdminUserConnection!
  }

  type AdminVerificationNode {
    user: User
    verification: VerificationDetails!
  }

  type AdminVerificationEdge {
    cursor: String!
    node: AdminVerificationNode!
  }

  type AdminVerificationConnection {
    edges: [AdminVerificationEdge!]!
    pageInfo: AdminPageInfo!
  }

  type AdmingetVerificationsResponse {
    code: Int!
    success: Boolean!
    message: String!
    verifications: AdminVerificationConnection!
  }

  type AdmingetSuspendedUSersResponse {
    code: Int!
    success: Boolean!
    message: String!
    suspendedUsers: AdminUserConnection!
  }

  type SupportAccountDetails {
    supportId: ID!
    email: String!
    username: String!
    isActive: Boolean!
    isSuspended: Boolean!
    hasSupportPrivileges: Boolean!
    createdAt: String!
    lastLogin: String
  }

  type SupportAccountEdge {
    cursor: String!
    node: SupportAccountDetails!
  }

  type SupportAccountConnection {
    edges: [SupportAccountEdge!]!
    pageInfo: AdminPageInfo!
  }

  type AdmingetSupportsResponse {
    code: Int!
    success: Boolean!
    message: String!
    supports: SupportAccountConnection!
  }

  type AdminSupportActionResponse {
    code: Int!
    success: Boolean!
    message: String!
    support: SupportAccountDetails
  }

  type AdminCreateOfficialStoreResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    store: StoreDetails
  }

  type AdminUserActionResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
  }

  type AdminGetTransactionsResponse {
    code: Int!
    success: Boolean!
    message: String!
    transactions: AdminTransactionConnection!
  }

  type AdmingetDisputesResponse {
    code: Int!
    success: Boolean!
    message: String!
    disputes: DisputeConnection!
  }

  type AdminOrderEdge {
    cursor: String!
    node: OrderDetails!
  }

  type AdminOrderConnection {
    edges: [AdminOrderEdge!]!
    pageInfo: AdminPageInfo!
  }

  type AdmingetOrdersResponse {
    code: Int!
    success: Boolean!
    message: String!
    orders: AdminOrderConnection!
  }

  type AdminPremiumNode {
    user: User!
    premium: PremiumDetails!
  }

  type AdminPremiumEdge {
    cursor: String!
    node: AdminPremiumNode!
  }

  type AdminPremiumConnection {
    edges: [AdminPremiumEdge!]!
    pageInfo: AdminPageInfo!
  }

  type AdmingetPremiumUsersResponse {
    code: Int!
    success: Boolean!
    message: String!
    premiumUsers: AdminPremiumConnection!
  }

  extend type Query {
    adminGetDetails(filter: AdminStatsFilter): AdminGetDetailsResponse!
    AdmingetTransactions(type: String, first: Int, after: String, last: Int, before: String): AdminGetTransactionsResponse!
    AdmingetUsers(first: Int, after: String, last: Int, before: String): AdmingetUsersResponse!
    AdmingetBuyers(first: Int, after: String, last: Int, before: String): AdmingetBuyersResponse!
    AdmingetStores(first: Int, after: String, last: Int, before: String): AdmingetStoresResponse!
    AdmingetVerifications(first: Int, after: String, last: Int, before: String): AdmingetVerificationsResponse!
    AdmingetSuspendedUSers(first: Int, after: String, last: Int, before: String): AdmingetSuspendedUSersResponse!
    AdmingetSupports(first: Int, after: String, last: Int, before: String): AdmingetSupportsResponse!
    AdmingetDisputes(first: Int, after: String, last: Int, before: String): AdmingetDisputesResponse!
    AdmingetOrders(status: String, first: Int, after: String, last: Int, before: String): AdmingetOrdersResponse!
    AdmingetPremiumUsers(first: Int, after: String, last: Int, before: String): AdmingetPremiumUsersResponse!
  }

  extend type Mutation {
    adminLogin(input: AdminLoginInput!): AdminLoginResponse!
    supportLogin(input: SupportLoginInput!): SupportLoginResponse!
    AdminSuspendUser(userId: ID!): AdminUserActionResponse!
    AdminActivativeUser(userId: ID!): AdminUserActionResponse!
    AdminaddSupport(email: String!, password: String!, username: String!): AdminSupportActionResponse!
    AdminSuspendSupport(supportId: ID!): AdminSupportActionResponse!
    AdminCreateOfficialStore: AdminCreateOfficialStoreResponse!
    AdminAddProduct(input: AddProductInput!): AddProductResponse!
    AdminUpdateProduct(input: UpdateProductInput!): UpdateProductResponse!
    AdminDeleteProduct(productId: ID!): DeleteProductResponse!
    AdminDisableProduct(productId: ID!): DeleteProductResponse!
    AdminEnableProduct(productId: ID!): DeleteProductResponse!
    AdminAddProductCodes(input: AddProductCodesInput!): AddProductCodesResponse!
    AdminDeleteProductCodes(input: DeleteProductCodesInput!): DeleteProductCodesResponse!
    AdminAdvertiseProduct(input: AdvertiseProductInput!): AdvertiseProductResponse!
    AdminAdvertiseStore(input: AdvertiseStoreInput!): AdvertiseStoreResponse!
  }
`;
