export const catalogsTypeDefs = `#graphql
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
    availableCodes: CodeConnection
    soldCodes: CodeConnection
  }

  extend type Query {
    fetchCatalog(name: String!, category: String, first: Int, after: String, last: Int, before: String): FetchCatalogResponse!
    getUserProducts(first: Int, after: String, last: Int, before: String): GetUserProductsResponse!
    viewProductCodes(productId: ID!, first: Int, after: String, last: Int, before: String): ViewProductCodesResponse!
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
    product: ProductDetails
  }

  type DeleteProductResponse {
    code: Int!
    success: Boolean!
    message: String!
  }

  extend type Mutation {
    addProduct(input: AddProductInput!): AddProductResponse!
    updateProduct(input: UpdateProductInput!): UpdateProductResponse!
    deleteProduct(productId: ID!): DeleteProductResponse!
    addProductCodes(input: AddProductCodesInput!): AddProductCodesResponse!
    deleteProductCodes(input: DeleteProductCodesInput!): DeleteProductCodesResponse!
  }
`;
