import { authQueries, authMutations } from "./modules/auth/resolvers.js";
import { usersQueries, usersMutations } from "./modules/users/resolvers.js";
import { walletsQueries, walletsMutations } from "./modules/wallets/resolvers.js";

export const resolvers = {
  Query: {
    _empty: () => true,
    ...authQueries,
    ...usersQueries,
    ...walletsQueries,
  },

  Mutation: {
    ...authMutations,
    ...usersMutations,
    ...walletsMutations,
  },
};

