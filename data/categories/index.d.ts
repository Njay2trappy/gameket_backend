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
export { gameVouchers, giftCards, directTopUp, prepaid, socialMediaEntertainment, };
/** All groups in display order */
export declare const allGroups: CategoryGroup[];
/** Flat lookup: slug → { name, groupId, groupTitle } */
export declare const categoryBySlug: Record<string, Category & {
    groupId: string;
    groupTitle: string;
}>;
/** All category slugs for static generation */
export declare const allSlugs: string[];
