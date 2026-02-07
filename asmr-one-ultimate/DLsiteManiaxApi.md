# DLsite Maniax API Documentation

This document describes the unofficial DLsite Maniax API endpoints and the `DLsiteApiClient` library implemented in this project.

**Note**: These APIs are internal AJAX endpoints used by the DLsite frontend and are subject to change without notice.

## Base URL
`https://www.dlsite.com/{domain}/api/=/`

Common domains:
- `maniax` (Voice/ASMR, Adult)
- `home` (All ages)
- `girls` (Otome)

## Endpoints

### 1. Product API (`product.json`)

Retrieves product information, either by ID (lookup) or keyword (search).

**URL**: `GET /product.json`

**Parameters**:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workno` | string | No* | RJ Code (e.g. `RJ123456`). *Required for lookup.* |
| `keyword_work_name` | string | No | Search keyword. |
| `maker_id` | string | No | Filter by Circle/Maker ID (e.g. `RG73627`). |
| `locale` | string | No | Locale code (default `ja-jp`). |

**Response**:
Returns a JSON array containing product objects.

```json
[
  {
    "workno": "RJ123456",
    "work_name": "Product Title",
    "maker_name": "Circle Name",
    "price": 770,
    "rate_average_star": 45,
    "contents": [...],
    "genres": [...]
  }
]
```

### 2. Review API (`review.json`)

Retrieves user reviews for a specific product.

**URL**: `GET /review.json`

**Parameters**:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workno` | string | Yes | RJ Code. |
| `limit` | number | No | Number of reviews (default 30). |
| `order` | string | No | Sort order (`new`, `rating_desc`). |
| `locale` | string | No | Locale code. |

**Response**:
Returns a JSON object containing a `review_list` array.

## Client Implementation

The `DLsiteApiClient` class provides a strongly-typed interface for these endpoints.

### Usage

```typescript
import { DLsiteApi } from './services/DLsiteApi';

// 1. Lookup Product
const product = await DLsiteApi.getProduct('RJ123456');
if (product) {
  console.log(product.work_name);
}

// 2. Search Products
const results = await DLsiteApi.search('imouto');
results.forEach(w => console.log(w.work_name));

// 3. Get Reviews
const reviews = await DLsiteApi.getReviews({ workno: 'RJ123456' });
if (reviews) {
  reviews.review_list.forEach(r => console.log(r.comment));
}
```

## Type Definitions

Full TypeScript interfaces are available in `src/types/dlsite.ts`:
- `DLsiteProductApiResponse` - Full product object structure.
- `DLsiteReviewApiResponse` - Review API structure.
- `DLsiteProductApiParams` - Request parameters.

## Testing

Unit tests are located in `tests/features/DLsiteApi.test.ts` and verify the client logic using mocked `HttpClient` responses.
