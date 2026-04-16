export const authTypeDefs = `#graphql
  input RegisterInput {
    email: String!
    username: String!
    country: String!
    password: String!
  }

  input LoginInput {
    email: String!
    password: String!
  }

  type RegisterResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
  }

  type LoginResponse {
    code: Int!
    success: Boolean!
    message: String!
    token: String
    user: User
  }

  input UpdatePasswordInput {
    oldPassword: String!
    newPassword: String!
  }

  type UpdatePasswordResponse {
    code: Int!
    success: Boolean!
    message: String!
  }

  type UpdateTwoFactorAuthResponse {
    code: Int!
    success: Boolean!
    message: String!
    twoFactorAuth: Boolean
  }

  extend type Mutation {
    register(input: RegisterInput!): RegisterResponse!
    login(input: LoginInput!): LoginResponse!
    updatePassword(input: UpdatePasswordInput!): UpdatePasswordResponse!
    updateTwoFactorAuth: UpdateTwoFactorAuthResponse!
  }

  # extend type Query {
  #   — auth queries go here (e.g. me, verifyToken)
  # }
`;
