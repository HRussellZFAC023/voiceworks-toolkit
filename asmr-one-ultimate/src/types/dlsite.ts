/**
 * DLsite API Type Definitions
 *
 * Comprehensive TypeScript interfaces for DLsite's product APIs and
 * the normalized metadata used throughout the application.
 *
 * API Endpoints:
 * - Product API:  GET https://www.dlsite.com/{domain}/api/=/product.json?workno={RJ}&locale=ja-jp
 *   Domains: maniax, home, girls, pro, ana, eng
 * - Dynamic API:  GET https://www.dlsite.com/maniax-touch/product/info/ajax?product_id={RJ}
 * - HTML Page:    GET https://www.dlsite.com/maniax/work/=/product_id/{RJ}.html
 * - HTML Page:    GET https://www.dlsite.com/maniax/work/=/product_id/{RJ}.html
 *   (Full description body is only available via HTML scraping — the JSON API returns intro: null)
 * - Review API:   GET https://www.dlsite.com/{domain}/api/=/review.json?workno={RJ}&limit={N}&order={order}
 */

// ============================================================================
// Product API Sub-types
// ============================================================================

/** Genre/tag entry from DLsite product API (genres, genres_replaced arrays) */
export interface DLsiteGenre {
    id: number;
    name: string;
    search_val?: string;
    name_base?: string;
}

/**
 * Creator entry from DLsite product API.
 * The `creaters` field can be either an array of these, or an object with `voice_by` array.
 */
export interface DLsiteCreater {
    name?: string;
    value?: string;
    type?: string;
    role?: string;
    job?: string;
}

/** Content/file entry from DLsite product API (contents, contents_touch arrays) */
export interface DLsiteContentFile {
    workno: string;
    type: string;
    file_name: string;
    file_size: string;
    file_size_unit: string;
    width: string | null;
    height: string | null;
    hash: string | null;
    display_mode: string;
    update_date: string;
    id: string;
    'upper(work_files.type)': string;
    extension: string;
    relative_url?: string;
    path_short?: string;
    url?: string;
    resize_url?: string;
    /** Touch-only fields */
    filepath?: string;
    name?: string;
    filesize?: string;
    size?: string;
    title?: string;
    name_url?: string;
}

/** Image file entry from DLsite product API (image_main, image_thum, etc.) */
export interface DLsiteImageFile {
    workno: string;
    type: string;
    file_name: string;
    file_size: string;
    file_size_unit: string;
    width: string;
    height: string;
    hash: string | null;
    display_mode: string;
    update_date: string;
    id: string;
    'upper(work_files.type)': string;
    extension: string;
    relative_url: string;
    path_short: string;
    url: string;
    resize_url: string;
}

/** Discount info from DLsite product API */
export interface DLsiteDiscountInfo {
    id: string;
    workno: string;
    status: string;
    campaign_id: number;
    start_date: number;
    end_date: number;
    campaign_price: number;
    discount_rate: number;
    restore_price: number;
    show_end_date_days: string;
    limit_dl_count: number | null;
    del_flg: string;
    update_date: string;
    update_id: string | null;
    insert_date: string;
    insert_id: string;
    access_key: string;
    title: string;
    options: unknown[];
}

/** Translation info from DLsite product API */
export interface DLsiteTranslationInfo {
    lang?: string | null;
    is_child?: boolean;
    is_parent?: boolean;
    is_original?: boolean;
    is_volunteer?: boolean;
    child_worknos?: string[];
    parent_workno?: string | null;
    original_workno?: string | null;
    [key: string]: unknown;
}

/** Work rental info */
export interface DLsiteWorkRental {
    [key: string]: unknown;
}

// ============================================================================
// Product API Response — Full Shape
// ============================================================================

/**
 * Full DLsite Product API Response.
 *
 * URL: `https://www.dlsite.com/{domain}/api/=/product.json?workno={RJ}&locale=ja-jp`
 *
 * The response is a JSON array with a single element. This interface represents
 * that element. Every field is optional because availability varies by product
 * type, domain, and locale.
 *
 * Derived from actual API responses curled 2026-01-28.
 */
export interface DLsiteProductApiResponse {
    // === Identity & Naming ===
    workno: string;
    work_name: string;
    work_name_masked: string;
    work_name_kana: string;
    product_id: string;
    base_product_id: string;
    product_name: string;
    alt_name: string;
    alt_name_masked: string;

    // === Classification ===
    age_category: number;
    age_category_string: 'adult' | 'general' | 'r15' | string;
    sex_category: number;
    work_type: string;
    work_type_string: string;
    work_type_special: string | null;
    work_type_special_masked: string | null;
    work_attributes: string;
    work_category: string;
    coupling: string[];

    // === Circle/Maker ===
    maker_id: string;
    maker_name: string;
    maker_name_en: string | null;
    circle_id: string;
    brand_id: string | null;
    label_id: string | null;
    label_name: string | null;

    // === Series ===
    series_id: string | null;
    series_name: string | null;
    series_name_masked: string | null;

    // === Title (for series works) ===
    title_id: string | null;
    title_name: string | null;
    title_name_masked: string | null;
    title_volumn: string | null;
    title_work_labeling: string | null;
    title_work_display_order: number | null;
    title_work_count: number | null;
    is_title_completed: boolean | null;
    title_latest_workno: string | null;
    title_price_low: number | null;
    title_price_high: number | null;
    is_title_pointup: boolean | null;
    title_point_rate: number | null;
    is_title_discount: boolean | null;
    is_title_reserve: boolean | null;

    // === Dates ===
    regist_date: string;
    update_date: string;
    file_date: string | null;

    // === Pricing ===
    price: number;
    price_without_tax: number;
    price_en: number;
    price_eur: number;
    regular_price: number | null;
    sales_price: number | null;
    official_price: number | null;
    official_price_without_tax: number | null;
    official_price_usd: number | null;
    official_price_eur: number | null;
    point: number;
    default_point: number;
    product_point: number | null;
    product_point_end_date: string | null;
    locale_price?: unknown;
    locale_official_price?: unknown;
    locale_price_str?: string;
    locale_official_price_str?: string;
    currency_price?: unknown;
    currency_official_price?: unknown;

    // === Discount / Campaign ===
    discount: DLsiteDiscountInfo | null;
    discount_rate: number | null;
    is_discount_work: boolean;
    discount_access_key: string | null;
    discount_layout: string | null;
    campaign_id: number | null;
    campaign_start_date: string | null;
    campaign_end_date: string | null;
    is_show_campaign_end_date: boolean | null;

    // === Text Content ===
    /**
     * Full product description HTML.
     * **Note:** This is consistently `null` in the JSON API response.
     * The full body is only available via HTML page scraping from the
     * `work_parts_container` div (itemprop="description").
     */
    intro: string | null;
    intro_masked: string | null;
    /** Brief summary text — the short product description. Always present. */
    intro_s: string;
    intro_s_masked: string;
    /** Extended product introductions (usually null, HTML content when present) */
    introductions: string | null;
    introductions_masked: string | null;

    // === Ratings & Stats ===
    is_show_rate: boolean;
    rate_average_star?: number;
    /** Rating distribution: keys are "1"-"5", values are counts */
    rate_count_detail: Record<string, number> | null;

    // === Rankings ===
    rank_total: number | null;
    rank_total_date: string | null;
    rank_year: number | null;
    rank_year_date: string | null;
    rank_month: number | null;
    rank_month_date: string | null;
    rank_week: number | null;
    rank_week_date: string | null;
    rank_day: number | null;
    rank_day_date: string | null;

    // === File Info ===
    file_type: string | null;
    file_type_string: string | null;
    file_type_special: string | null;
    file_size: string | null;
    dl_format: number;
    dist_flag: number;

    // === Content Files ===
    contents: DLsiteContentFile[];
    contents_touch: DLsiteContentFile[];
    is_split_content: boolean;
    content_count: number;
    content_count_touch: number;
    contents_file_size: string;
    contents_file_size_touch: string;

    // === Trials / Samples ===
    trials: unknown[];
    trials_touch: unknown[];
    movies: unknown[];
    epub_sample: unknown | null;
    sample_type: string | null;
    is_viewable_sample: boolean;
    chobits: unknown | null;

    // === Images ===
    image_main: DLsiteImageFile;
    image_thum: DLsiteImageFile;
    image_thum_mini: DLsiteImageFile;
    image_thum_touch: DLsiteImageFile[];
    image_thum_mini_touch: Array<{ url: string }>;
    image_mini: { url: string };
    image_samples: DLsiteImageFile[];
    image_thumb: string;
    image_thumb_touch: string;

    // === Genres / Tags ===
    genres: DLsiteGenre[];
    genres_replaced: DLsiteGenre[];
    custom_genres: unknown[];

    // === Creators ===
    /**
     * Can be either:
     * - An array of DLsiteCreater (with type/role fields)
     * - An object with `voice_by` array property
     * - An empty array
     */
    creaters: DLsiteCreater[] | { voice_by?: DLsiteCreater[] };
    voice_by: DLsiteCreater[] | null;
    voice: DLsiteCreater[] | null;
    scenario_by: string | null;
    music_by: string | null;
    directed_by: string | null;
    original_illust: string | null;
    others_by: string | null;

    // === Platform / Distribution ===
    site_id: string;
    site_id_touch: string;
    on_sale: number;
    options: string;
    platform: string[];
    is_pc_work: boolean;
    is_smartphone_work: boolean;
    is_android_only_work: boolean;
    is_ios_only_work: boolean;
    is_android_or_ios_only_work: boolean;
    is_dlplaybox_only_work: boolean;
    is_almight_work: boolean;
    is_dlsiteplay_work: boolean;
    is_dlsiteplay_only_work: boolean;
    is_ana: boolean;

    // === Display / UI ===
    work_options: unknown | null;
    display_options: unknown | null;
    work_browse_setting: unknown | null;
    touch_style1: unknown | null;
    display_order: number | null;

    // === Reserve / Bonus ===
    reserve_work: unknown | null;
    is_reserve_work: boolean;
    is_reservable: boolean;
    is_downloadable_reserve_work: boolean;
    bonus_workno: string | null;
    bonus_work: unknown | null;
    is_bonus_work: boolean;
    is_downloadable_bonus_work: boolean;
    parent_reserve_workno: string | null;
    production_workno: string | null;
    publisher_workno: string | null;

    // === Pack / Bundle ===
    is_pack_child: boolean;
    work_pack_parent: unknown | null;
    is_pack_parent: boolean;
    work_pack_children: unknown[];
    pack_type: string | null;
    is_voice_pack: boolean;
    voice_pack_parent: unknown | null;
    voice_pack_child: unknown | null;

    // === Free / Limited ===
    free: unknown | null;
    free_only: boolean | null;
    free_end_date: string | null;
    has_free_download: boolean;
    limited_free_terms: unknown | null;
    limited_free_work: unknown | null;

    // === Limit Sales ===
    is_limit_work: boolean;
    is_limit_sales: boolean;
    is_limit_in_stock: boolean;
    limit_sale_id: string | null;
    limit_start_date: string | null;
    limit_end_date: string | null;
    limit_dl_count: number | null;
    limit_sold_dl_count: number | null;
    limit_display_type: string | null;

    // === Time Sale ===
    is_timesale_work: boolean;
    timesale_dl_count: number | null;
    timesale_limit_dl_count: number | null;
    timesale_stock: number | null;
    timesale_start_date: string | null;
    timesale_end_date: string | null;
    timesale_price: number | null;

    // === Rental ===
    work_rentals: DLsiteWorkRental[];
    is_rental_work: boolean;
    gift: unknown | null;

    // === Bulk Buy ===
    is_bulkbuy: boolean;
    bulkbuy_key: string | null;
    bulkbuy_title: string | null;
    bulkbuy_per_items: number | null;
    bulkbuy_start: string | null;
    bulkbuy_end: string | null;
    bulkbuy_price: number | null;
    bulkbuy_price_tax: number | null;
    bulkbuy_price_without_tax: number | null;
    bulkbuy_discount_rate: number | null;
    bulkbuy_point_rate: number | null;
    bulkbuy_point: number | null;

    // === Language / Translation ===
    language_editions: unknown[];
    editions: unknown[];
    translation_info: DLsiteTranslationInfo | null;
    is_oauth_work: boolean;

    // === Coupon / Volume Discounts ===
    given_coupons_by_buying: unknown[];
    specified_volume_sets: unknown[];
    specified_volume_set_max_discount_rate: number | null;
    has_specified_volume_set: boolean;

    // === Category Flags ===
    is_bl: boolean;
    is_tl: boolean;
    is_drama_work: boolean;
    is_display_notice: boolean;
    book_type: string | null;
    is_garumani_general: boolean;
    is_garumani_general_comipo_mirror: boolean;

    // === System Requirements (legacy) ===
    anime: string | null;
    auto_play: string | null;
    bgm: string | null;
    bgm_mode: string | null;
    books_id: string | null;
    cpu: string | null;
    directx: string | null;
    gallery_mode: string | null;
    hdd: string | null;
    h_scene_mode: string | null;
    machine: string;
    machine_string_list: string[];
    memory: string | null;
    message_skip: string | null;
    mini_resolution: string | null;
    pages: number | null;
    page_number: number | null;
    screen_mode: string | null;
    vram: string | null;
    vocal_track: string | null;

    // === Misc ===
    modify_flg: number;
    other: string | null;
    etc: string | null;
    sofrin_app_no: string | null;
    work_parts: unknown[];
    rating: unknown | null;
    product_dir: string;
    srcset: unknown | null;

    /** Catch-all for undocumented or future fields */
    [key: string]: unknown;
}

// ============================================================================
// Dynamic API Response
// ============================================================================

/**
 * DLsite Dynamic/Touch API Response.
 *
 * URL: `https://www.dlsite.com/maniax-touch/product/info/ajax?product_id={RJ}`
 *
 * Response is a JSON object keyed by work number (e.g. `{ "RJ01470225": { ... } }`).
 * May also be nested under `data`, `product`, `work`, or `items` keys.
 */
export interface DLsiteDynamicEntry {
    rate_average_2dp?: number;
    rate_average?: number;
    price?: number;
    dl_count?: string | number;
    [key: string]: unknown;
}

export interface DLsiteDynamicApiResponse {
    [workno: string]: DLsiteDynamicEntry;
}

// ============================================================================
// Review API Response
// ============================================================================

/**
 * Review entry from /api/=/review.json
 */
export interface DLsiteReviewEntry {
    review_id: string;
    target_id: string;
    site_id: string;
    reviewer_id: string;
    reviewer_name: string;
    reviewer_all_count: string;
    reviewer_del_count: string;
    star: number;
    title: string;
    comment: string;
    spoiler: boolean;
    contents_status: number;
    regist_date: string;
    update_date: string;
    status: number;
    like_count: number;
}

/**
 * Full DLsite Review API Response.
 * URL: `https://www.dlsite.com/{domain}/api/=/review.json`
 */
export interface DLsiteReviewApiResponse {
    is_authorized: number;
    reviewer_status: number;
    product_param: {
        product_id: string;
        product_name: string;
        maker_id: string;
        maker_name: string;
        site_id: string;
        work_type: string;
    };
    review_param: {
        total_count: number;
    };
    review_list: DLsiteReviewEntry[];
    // Sometimes the API wraps list in 'review_list', sometimes it returns a direct array in other contexts
    // but the official ajax endpoint usually follows this structure or similar.
    // We'll define the standard shape observed.
}

// ============================================================================
// API Request Parameters
// ============================================================================

export interface DLsiteProductApiParams {
    /** RJ code (e.g. RJ123456) */
    workno?: string;
    /** Locale code (e.g. ja-jp) */
    locale?: string;
    /** Circle/Maker ID (optional filter) */
    maker_id?: string;
    /** Search keyword (optional) */
    keyword_work_name?: string;
}

export interface DLsiteReviewApiParams {
    workno: string;
    /** Number of reviews to fetch (default 30) */
    limit?: number;
    /** Sort order (e.g. 'new', 'rating_desc') */
    order?: 'new' | 'rating_desc' | 'rating_asc';
    /** Offset for pagination */
    offset?: number;
    locale?: string;
}

// ============================================================================
// Normalized Application Metadata
// ============================================================================

/**
 * Normalized DLsite metadata used throughout the application.
 *
 * This is the parsed/cleaned representation produced by `DLsiteScraper.parseApi()`
 * from the raw `DLsiteProductApiResponse`. All fields use a consistent shape
 * regardless of which scraping strategy succeeded.
 */
export interface DLsiteMetadata {
    rjcode: string;
    title: string;
    circle?: { id: number; name: string };
    series?: { id: number; name: string };
    maker?: { id: number; name: string };
    nsfw: boolean;
    release: string;
    tags: { id: number; name: string }[];
    cvs: { name: string }[];

    // Parity fields with asmr.one API
    age_category_string: string;
    file_size_string?: string;
    rating_average: number;
    price: number;
    dl_count?: string;
    summary?: string;

    // Extended fields
    /** Brief description from `intro_s` — the short product summary */
    description?: string;
    /** Full product description body (HTML) scraped from the DLsite page */
    body?: string;
    /** Intro text (from API `intro` field when available, usually null) */
    intro?: string;
    /** Sample image URLs from the DLsite product API */
    image_samples?: string[];
    /** Main cover image URL */
    image_main?: string;
    rank?: { [key: string]: number | string };
    discount?: { rate: number; end_date: string };
    contents?: { file_name: string; file_size: string }[];
    rate_count_detail?: { [key: string]: number };
}

/** A user review scraped from the DLsite product page */
export interface DLsiteUserReview {
    username: string;
    rating: number;
    text: string;
    date: string;
    source: 'dlsite';
    /** Which RJ code edition this review came from */
    source_rjcode?: string;
}
