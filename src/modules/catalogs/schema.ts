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

  extend type Query {
    fetchCatalog(name: String!, category: String, first: Int, after: String, last: Int, before: String): FetchCatalogResponse!
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

  extend type Mutation {
    addProduct(input: AddProductInput!): AddProductResponse!
  }
`;
