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
    requiresTwoFactor: Boolean!
    twoFactorToken: String
  }

  input UpdatePasswordInput {
    oldPassword: String!
    newPassword: String!
  }

  type UpdatePasswordResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
  }

  type UpdateTwoFactorAuthResponse {
    code: Int!
    success: Boolean!
    message: String!
    user: User
    twoFactorAuth: Boolean
  }

  type TwoFactorSetupData {
    otpAuthUrl: String!
    qrCodeDataUrl: String!
    manualEntryKey: String!
  }

  type TwoFactorSetupResponse {
    code: Int!
    success: Boolean!
    message: String!
    setup: TwoFactorSetupData
  }

  input VerifyTwoFactorSetupInput {
    code: String!
  }

  input DisableTwoFactorAuthInput {
    code: String!
  }

  input VerifyTwoFactorLoginInput {
    twoFactorToken: String!
    code: String!
  }

  input SendVerificationInput {
    email: String!
  }

  type SendVerificationResponse {
    code: Int!
    success: Boolean!
    message: String!
  }

  input CompleteVerificationInput {
    email: String!
    otp: String!
  }

  type CompleteVerificationResponse {
    code: Int!
    success: Boolean!
    message: String!
  }

  input GoogleSignInInput {
    idToken: String!
    username: String
    country: String
  }

  extend type Mutation {
    register(input: RegisterInput!): RegisterResponse!
    login(input: LoginInput!): LoginResponse!
    googleSignIn(input: GoogleSignInInput!): LoginResponse!
    verifyTwoFactorLogin(input: VerifyTwoFactorLoginInput!): LoginResponse!
    updatePassword(input: UpdatePasswordInput!): UpdatePasswordResponse!
    beginTwoFactorSetup: TwoFactorSetupResponse!
    verifyTwoFactorSetup(input: VerifyTwoFactorSetupInput!): UpdateTwoFactorAuthResponse!
    disableTwoFactorAuth(input: DisableTwoFactorAuthInput!): UpdateTwoFactorAuthResponse!
    updateTwoFactorAuth: UpdateTwoFactorAuthResponse!
    sendVerification(input: SendVerificationInput!): SendVerificationResponse!
    completeVerification(input: CompleteVerificationInput!): CompleteVerificationResponse!
  }

  # extend type Query {
  #   — auth queries go here (e.g. me, verifyToken)
  # }
`;
