export const catalogsTypeDefs = `#graphql
  enum ProductType {
    Auto
    Manual
  }

  enum StoreType {
    basic
    premium
    merchant
    official
  }

  enum ApproveStatus {
    pending
    success
    failed
  }

  enum Gender {
    Male
    Female
    Other
  }

  enum WorkingDay {
    MONDAY
    TUESDAY
    WEDNESDAY
    THURSDAY
    FRIDAY
    SATURDAY
    SUNDAY
  }

  type StoreDetails {
    storeId: ID!
    storeName: String!
    bio: String
    storeImage: String
    isActive: Boolean!
    isApproved: Boolean!
    approveStatus: ApproveStatus
    isPromoted: Boolean!
    type: StoreType!
    totalSales: Int!
    positiveReviews: Int!
    negativeReviews: Int!
    reviews: [ReviewDetails!]
    registered: String!
    requestCount: Int!
  }

  type CategoryNode {
    slug: String!
    name: String!
    groupId: String!
    groupTitle: String!
  }

  type CategoryEdge {
    cursor: String!
    node: CategoryNode!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
    fetchedCount: Int!
    remainingCount: Int!
  }

  type CategoryConnection {
    edges: [CategoryEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type CatalogGroup {
    id: String!
    title: String!
    icon: String!
    categories: CategoryConnection!
  }

  type FetchCatalogResponse {
    code: Int!
    success: Boolean!
    message: String!
    group: CatalogGroup
    item: CategoryNode
  }

  type ProductEdge {
    cursor: String!
    node: ProductDetails!
  }

  type ProductConnection {
    edges: [ProductEdge!]!
    pageInfo: CodePageInfo!
  }

  type GetUserProductsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    product: ProductDetails
    products: ProductConnection
  }

  type GetUserProductCallbackurlResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    product: ProductDetails
    callbackurl: String
  }

  type CodeEdge {
    cursor: String!
    node: String!
  }

  type CodeConnection {
    edges: [CodeEdge!]!
    pageInfo: CodePageInfo!
  }

  type CodePageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
    fetchedCount: Int!
    remainingCount: Int!
  }

  type ViewProductCodesResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    isManualProduct: Boolean!
    availableCount: Int!
    soldCount: Int!
    availableCodes: CodeConnection
    soldCodes: CodeConnection
  }

  type GetUserAdvertisableProductsResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    products: ProductConnection
  }

  type CheckProductADPositionResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    category: String
    overallPosition: Int
    categoryPosition: Int
    totalPromoted: Int
    totalPromotedInCategory: Int
  }

  type PromotedProductEdge {
    cursor: String!
    node: GetProductsProductDetails!
  }

  type PromotedProductConnection {
    edges: [PromotedProductEdge!]!
    pageInfo: PageInfo!
  }

  type GetPromotedProductsResponse {
    code: Int!
    success: Boolean!
    message: String!
    products: PromotedProductConnection
  }

  type PromotedStoreEdge {
    cursor: String!
    node: StoreDetails!
  }

  type PromotedStoreConnection {
    edges: [PromotedStoreEdge!]!
    pageInfo: PageInfo!
  }

  type GetPromotedStoresResponse {
    code: Int!
    success: Boolean!
    message: String!
    store: PromotedStoreConnection
  }

  type GetProductsProductDetails {
    productId: ID!
    catalog: String!
    category: String!
    region: String!
    name: String!
    description: String!
    marketPrice: Float!
    price: Float!
    discount: Float!
    isActive: Boolean!
    isPromoted: Boolean!
    isAPI: Boolean!
    available: Int!
    sold: Int!
    type: ProductType!
    manualOrderConfig: ManualOrderConfig
    createdAt: String!
    store: StoreDetails
    reviews: [ReviewDetails!]
  }

  type ManualOrderWorkingDay {
    day: WorkingDay!
    openTime: String!
    closeTime: String!
  }

  type ManualOrderConfig {
    isadditional: Boolean!
    characterCount: Int
    orderDescription: String
    workingDays: [ManualOrderWorkingDay!]!
  }

  type GetProductsEdge {
    cursor: String!
    node: GetProductsProductDetails!
  }

  type GetProductsConnection {
    edges: [GetProductsEdge!]!
    pageInfo: PageInfo!
  }

  type GetProductsResponse {
    code: Int!
    success: Boolean!
    message: String!
    products: GetProductsConnection
  }

  type GetProductDetailsResponse {
    code: Int!
    success: Boolean!
    message: String!
    product: GetProductsProductDetails
  }

  type GetStoreDetailsPublicResponse {
    code: Int!
    success: Boolean!
    message: String!
    store: StoreDetails
    products: ProductConnection
  }

  type StoreEdge {
    cursor: String!
    node: StoreDetails!
  }

  type StoreConnection {
    edges: [StoreEdge!]!
    pageInfo: PageInfo!
  }

  type GetStoresResponse {
    code: Int!
    success: Boolean!
    message: String!
    stores: StoreConnection
  }

  extend type Query {
    fetchCatalog(name: String!, category: String, first: Int, after: String, last: Int, before: String): FetchCatalogResponse!
    getUserProducts(productId: ID, first: Int, after: String, last: Int, before: String): GetUserProductsResponse!
    getUserProductCallbackurl(productId: ID!): GetUserProductCallbackurlResponse!
    getUserAdvertisableProducts(first: Int, after: String, last: Int, before: String): GetUserAdvertisableProductsResponse!
    viewProductCodes(productId: ID!, first: Int, after: String, last: Int, before: String): ViewProductCodesResponse!
    checkProductADPosition(productId: ID!, amount: Float!): CheckProductADPositionResponse!
    checkStoreADPosition(amount: Float!): CheckStoreADPositionResponse!
    getPromotedProducts(first: Int, after: String, last: Int, before: String): GetPromotedProductsResponse!
    getPromotedStores(first: Int, after: String, last: Int, before: String): GetPromotedStoresResponse!
    getProducts(category: String!, region: String, min: Float, max: Float, sort: ProductSort, first: Int, after: String, last: Int, before: String): GetProductsResponse!
    getProductDetails(productId: ID!): GetProductDetailsResponse!
    getStoreDetails(storeId: ID!, first: Int, after: String, last: Int, before: String): GetStoreDetailsPublicResponse!
    getStores(first: Int, after: String, last: Int, before: String): GetStoresResponse!
    getVerificationRequest(storeId: ID!, superkey: String!): GetVerificationRequestResponse!
    getStoreBlacklist(first: Int, after: String, last: Int, before: String): GetStoreBlacklistResponse!
  }

  enum ProductSort {
    LOW_HIGH
    RANK
    QUANTITY_SOLD
  }

  type ProductDetails {
    productId: ID!
    catalog: String!
    category: String!
    region: String!
    name: String!
    description: String!
    marketPrice: Float!
    price: Float!
    discount: Float!
    isActive: Boolean!
    isPromoted: Boolean!
    isAPI: Boolean!
    available: Int!
    sold: Int!
    type: ProductType!
    manualOrderConfig: ManualOrderConfig
    createdAt: String!
  }

  input AddProductInput {
    catalog: String!
    category: String!
    region: String!
    name: String!
    description: String!
    marketPrice: Float!
    price: Float!
    type: ProductType!
    isAPI: Boolean
  }

  type AddProductResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    product: ProductDetails
  }

  input AddProductCodesInput {
    productId: ID!
    codes: [String!]!
  }

  input AddProductCodesbyAPIInput {
    productId: ID!
    callbackurl: String!
  }

  input ManualOrderWorkingDayInput {
    day: WorkingDay!
    openTime: String!
    closeTime: String!
  }

  input AddProductManualcodesInput {
    productId: ID!
    quantity: Int!
    isadditional: Boolean!
    characterCount: Int
    orderDescription: String
    workingDays: [ManualOrderWorkingDayInput!]
  }

  input AddProductManualcodesbyAPIInput {
    productId: ID!
    isadditional: Boolean!
    characterCount: Int
    orderDescription: String
    callbackurl: String!
  }

  type AddProductCodesResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    available: Int
  }

  type AddProductManualcodesResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    available: Int
    product: ProductDetails
  }

  input UpdateProductCallbackurlInput {
    productId: ID!
    callbackurl: String!
  }

  type UpdateProductCallbackurlResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    callbackurl: String
    product: ProductDetails
  }

  input DeleteProductCodesInput {
    productId: ID!
    codes: [String!]!
  }

  input DeleteProductManualcodesInput {
    productId: ID!
    quantity: Int!
  }

  type DeleteProductCodesResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    available: Int
  }

  type DeleteProductManualcodesResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    available: Int
    fulfilledManualOrders: Int
    product: ProductDetails
  }

  input UpdateProductInput {
    productId: ID!
    description: String
    marketPrice: Float
    price: Float
  }

  type UpdateProductResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    product: ProductDetails
  }

  type DeleteProductResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    product: ProductDetails
  }

  input AdvertiseProductInput {
    productId: ID!
    amount: Float!
    campaignStart: Date!
    campaignEnd: Date!
  }

  type PromotedProductDetails {
    productId: ID!
    amount: Float!
    campaignStart: Date!
    campaignEnd: Date!
    createdAt: String!
    product: ProductDetails!
    store: StoreDetails
  }

  type AdvertiseProductResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    promotion: PromotedProductDetails
  }

  type CheckStoreADPositionResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    overallPosition: Int
    totalPromoted: Int
  }

  input AdvertiseStoreInput {
    amount: Float!
    campaignStart: Date!
    campaignEnd: Date!
  }

  type PromotedStoreDetails {
    storeId: ID!
    amount: Float!
    campaignStart: Date!
    campaignEnd: Date!
    createdAt: String!
    store: StoreDetails!
  }

  type AdvertiseStoreResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    promotion: PromotedStoreDetails
  }

  input RequestStoreAccessInput {
    surname: String!
    otherNames: String!
    gender: Gender!
    dateOfBirth: String!
    address: String!
    nationality: String!
    identification: String!
    proofPerson: String!
  }

  type RequestStoreAccessResponse {
    code: Int!
    success: Boolean!
    message: String!
  }

  type VerificationDetails {
    userId: String!
    storeId: String!
    storeName: String!
    surname: String!
    otherNames: String!
    gender: Gender!
    dateOfBirth: String!
    address: String!
    nationality: String!
    identification: String!
    proofPerson: String!
    submittedAt: String!
  }

  type GetVerificationRequestResponse {
    code: Int!
    success: Boolean!
    message: String!
    verification: VerificationDetails
  }

  type AdminAuthorizeStoreResponse {
    code: Int!
    success: Boolean!
    message: String!
  }

  type UploadImageResponse {
    code: Int!
    success: Boolean!
    message: String!
    url: String
    deleteUrl: String
  }

  type BlacklistResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
  }

  type BlacklistEntry {
    userId: String!
    username: String!
    avatar: String
    createdAt: String!
  }

  type BlacklistEdge {
    cursor: String!
    node: BlacklistEntry!
  }

  type BlacklistConnection {
    edges: [BlacklistEdge!]!
    pageInfo: BlacklistPageInfo!
  }

  type BlacklistPageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
    fetchedCount: Int!
    remainingCount: Int!
  }

  type GetStoreBlacklistResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    blacklist: BlacklistConnection
  }

  extend type Mutation {
    addProduct(input: AddProductInput!): AddProductResponse!
    updateProduct(input: UpdateProductInput!): UpdateProductResponse!
    deleteProduct(productId: ID!): DeleteProductResponse!
    disableProduct(productId: ID!): DeleteProductResponse!
    enableProduct(productId: ID!): DeleteProductResponse!
    addProductCodes(input: AddProductCodesInput!): AddProductCodesResponse!
    addProductcodesbyAPI(input: AddProductCodesbyAPIInput!): AddProductCodesResponse!
    addProductManualcodes(input: AddProductManualcodesInput!): AddProductManualcodesResponse!
    addProductManualcodesbyAPI(input: AddProductManualcodesbyAPIInput!): AddProductManualcodesResponse!
    updateProductCallbackurl(input: UpdateProductCallbackurlInput!): UpdateProductCallbackurlResponse!
    deleteProductCodes(input: DeleteProductCodesInput!): DeleteProductCodesResponse!
    deleteProductManualcodes(input: DeleteProductManualcodesInput!): DeleteProductManualcodesResponse!
    advertiseProduct(input: AdvertiseProductInput!): AdvertiseProductResponse!
    advertiseStore(input: AdvertiseStoreInput!): AdvertiseStoreResponse!
    requestStoreAccess(input: RequestStoreAccessInput!): RequestStoreAccessResponse!
    adminAuthorizeStore(storeId: ID!, superkey: String, token: String): AdminAuthorizeStoreResponse!
    adminRejectStore(storeId: ID!, superkey: String, token: String): AdminAuthorizeStoreResponse!
    uploadImage(image: String!): UploadImageResponse!
    blacklistUser(userId: ID!): BlacklistResponse!
    delistUser(userId: ID!): BlacklistResponse!
  }
`;
