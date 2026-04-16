import gameVouchers from "./game-vouchers.json";
import giftCards from "./gift-cards.json";
import directTopUp from "./direct-top-up.json";
import prepaid from "./prepaid.json";
import socialMediaEntertainment from "./social-media-entertainment.json";

export interface Category {
  slug: string;
  name: string;
}

export interface CategoryGroup {
  id: string;
  title: string;
  icon: string;
  categories: Category[];
}

export {
  gameVouchers,
  giftCards,
  directTopUp,
  prepaid,
  socialMediaEntertainment,
};

/** All groups in display order */
export const allGroups: CategoryGroup[] = [
  gameVouchers,
  giftCards,
  directTopUp,
  prepaid,
  socialMediaEntertainment,
];

/** Flat lookup: slug → { name, groupId, groupTitle } */
export const categoryBySlug: Record<
  string,
  Category & { groupId: string; groupTitle: string }
> = Object.fromEntries(
  allGroups.flatMap((group) =>
    group.categories.map((cat) => [
      cat.slug,
      { ...cat, groupId: group.id, groupTitle: group.title },
    ])
  )
);

/** All category slugs for static generation */
export const allSlugs: string[] = allGroups.flatMap((g) =>
  g.categories.map((c) => c.slug)
);
