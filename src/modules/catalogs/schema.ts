export const catalogsTypeDefs = `#graphql
  type StoreDetails {
    storeId: ID!
    storeName: String!
    isActive: Boolean!
    isPromoted: Boolean!
    type: String!
    totalSales: Int!
    positiveReviews: Int!
    negativeReviews: Int!
    registered: Date!
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
    available: Int!
    sold: Int!
    createdAt: String!
    store: StoreDetails
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
    available: Int!
    sold: Int!
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

  type AddProductCodesResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    available: Int
  }

  input DeleteProductCodesInput {
    productId: ID!
    codes: [String!]!
  }

  type DeleteProductCodesResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    available: Int
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

  extend type Mutation {
    addProduct(input: AddProductInput!): AddProductResponse!
    updateProduct(input: UpdateProductInput!): UpdateProductResponse!
    deleteProduct(productId: ID!): DeleteProductResponse!
    disableProduct(productId: ID!): DeleteProductResponse!
    addProductCodes(input: AddProductCodesInput!): AddProductCodesResponse!
    deleteProductCodes(input: DeleteProductCodesInput!): DeleteProductCodesResponse!
    advertiseProduct(input: AdvertiseProductInput!): AdvertiseProductResponse!
    advertiseStore(input: AdvertiseStoreInput!): AdvertiseStoreResponse!
  }
`;
