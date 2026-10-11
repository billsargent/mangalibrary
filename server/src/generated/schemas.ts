// AUTO-GENERATED - do not edit by hand.
// Source: spec/komga-openapi.json (Komga API v1.28.1).
// Regenerate with: npm run generate:schemas

import type { FastifyInstance } from 'fastify'

export interface GeneratedRoute {
  method: string
  url: string
  operationId: string
  schema: Record<string, unknown>
}

export const specVersion = "1.28.1"

/** Component schemas from the OpenAPI spec, with refs rewritten for Ajv. */
export const definitions: Record<string, unknown> = {
  "AgeRestrictionDto": {
    "type": "object",
    "properties": {
      "age": {
        "type": "integer",
        "format": "int32"
      },
      "restriction": {
        "type": "string",
        "enum": [
          "ALLOW_ONLY",
          "EXCLUDE"
        ]
      }
    },
    "required": [
      "age",
      "restriction"
    ]
  },
  "AgeRestrictionUpdateDto": {
    "type": "object",
    "properties": {
      "age": {
        "type": "integer",
        "format": "int32"
      },
      "restriction": {
        "type": "string",
        "enum": [
          "ALLOW_ONLY",
          "EXCLUDE",
          "NONE"
        ]
      }
    },
    "required": [
      "age",
      "restriction"
    ]
  },
  "AlternateTitleDto": {
    "type": "object",
    "properties": {
      "label": {
        "type": "string"
      },
      "title": {
        "type": "string"
      }
    },
    "required": [
      "label",
      "title"
    ]
  },
  "AlternateTitleUpdateDto": {
    "type": "object",
    "properties": {
      "label": {
        "type": "string",
        "minLength": 1
      },
      "title": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "label",
      "title"
    ]
  },
  "ApiKeyDto": {
    "type": "object",
    "properties": {
      "comment": {
        "type": "string"
      },
      "createdDate": {
        "type": "string",
        "format": "date-time"
      },
      "id": {
        "type": "string"
      },
      "key": {
        "type": "string"
      },
      "lastModifiedDate": {
        "type": "string",
        "format": "date-time"
      },
      "userId": {
        "type": "string"
      }
    },
    "required": [
      "comment",
      "createdDate",
      "id",
      "key",
      "lastModifiedDate",
      "userId"
    ]
  },
  "ApiKeyRequestDto": {
    "type": "object",
    "properties": {
      "comment": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "comment"
    ]
  },
  "AuthenticationActivityDto": {
    "type": "object",
    "properties": {
      "apiKeyComment": {
        "type": "string"
      },
      "apiKeyId": {
        "type": "string"
      },
      "dateTime": {
        "type": "string",
        "format": "date-time"
      },
      "email": {
        "type": "string"
      },
      "error": {
        "type": "string"
      },
      "ip": {
        "type": "string"
      },
      "source": {
        "type": "string"
      },
      "success": {
        "type": "boolean"
      },
      "userAgent": {
        "type": "string"
      },
      "userId": {
        "type": "string"
      }
    },
    "required": [
      "dateTime",
      "success"
    ]
  },
  "AuthorDto": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string"
      },
      "role": {
        "type": "string"
      }
    },
    "required": [
      "name",
      "role"
    ]
  },
  "AuthorUpdateDto": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1
      },
      "role": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "name",
      "role"
    ]
  },
  "BookDto": {
    "type": "object",
    "properties": {
      "created": {
        "type": "string",
        "format": "date-time"
      },
      "deleted": {
        "type": "boolean"
      },
      "fileHash": {
        "type": "string"
      },
      "fileLastModified": {
        "type": "string",
        "format": "date-time"
      },
      "id": {
        "type": "string"
      },
      "lastModified": {
        "type": "string",
        "format": "date-time"
      },
      "libraryId": {
        "type": "string"
      },
      "media": {
        "$ref": "komga#/definitions/MediaDto"
      },
      "metadata": {
        "$ref": "komga#/definitions/BookMetadataDto"
      },
      "name": {
        "type": "string"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "oneshot": {
        "type": "boolean"
      },
      "readProgress": {
        "$ref": "komga#/definitions/ReadProgressDto"
      },
      "seriesId": {
        "type": "string"
      },
      "seriesTitle": {
        "type": "string"
      },
      "size": {
        "type": "string"
      },
      "sizeBytes": {
        "type": "integer",
        "format": "int64"
      },
      "url": {
        "type": "string"
      }
    },
    "required": [
      "created",
      "deleted",
      "fileHash",
      "fileLastModified",
      "id",
      "lastModified",
      "libraryId",
      "media",
      "metadata",
      "name",
      "number",
      "oneshot",
      "seriesId",
      "seriesTitle",
      "size",
      "sizeBytes",
      "url"
    ]
  },
  "BookImportBatchDto": {
    "type": "object",
    "properties": {
      "books": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/BookImportDto"
        }
      },
      "copyMode": {
        "type": "string",
        "enum": [
          "MOVE",
          "COPY",
          "HARDLINK"
        ]
      }
    },
    "required": [
      "books",
      "copyMode"
    ]
  },
  "BookImportDto": {
    "type": "object",
    "properties": {
      "destinationName": {
        "type": "string"
      },
      "seriesId": {
        "type": "string"
      },
      "sourceFile": {
        "type": "string"
      },
      "upgradeBookId": {
        "type": "string"
      }
    },
    "required": [
      "seriesId",
      "sourceFile"
    ]
  },
  "BookMetadataAggregationDto": {
    "type": "object",
    "properties": {
      "authors": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/AuthorDto"
        }
      },
      "created": {
        "type": "string",
        "format": "date-time"
      },
      "lastModified": {
        "type": "string",
        "format": "date-time"
      },
      "releaseDate": {
        "type": "string",
        "format": "date"
      },
      "summary": {
        "type": "string"
      },
      "summaryNumber": {
        "type": "string"
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      }
    },
    "required": [
      "authors",
      "created",
      "lastModified",
      "summary",
      "summaryNumber",
      "tags"
    ]
  },
  "BookMetadataDto": {
    "type": "object",
    "properties": {
      "authors": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/AuthorDto"
        }
      },
      "authorsLock": {
        "type": "boolean"
      },
      "created": {
        "type": "string",
        "format": "date-time"
      },
      "isbn": {
        "type": "string"
      },
      "isbnLock": {
        "type": "boolean"
      },
      "lastModified": {
        "type": "string",
        "format": "date-time"
      },
      "links": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WebLinkDto"
        }
      },
      "linksLock": {
        "type": "boolean"
      },
      "number": {
        "type": "string"
      },
      "numberLock": {
        "type": "boolean"
      },
      "numberSort": {
        "type": "number",
        "format": "float"
      },
      "numberSortLock": {
        "type": "boolean"
      },
      "releaseDate": {
        "type": "string",
        "format": "date"
      },
      "releaseDateLock": {
        "type": "boolean"
      },
      "summary": {
        "type": "string"
      },
      "summaryLock": {
        "type": "boolean"
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "tagsLock": {
        "type": "boolean"
      },
      "title": {
        "type": "string"
      },
      "titleLock": {
        "type": "boolean"
      }
    },
    "required": [
      "authors",
      "authorsLock",
      "created",
      "isbn",
      "isbnLock",
      "lastModified",
      "links",
      "linksLock",
      "number",
      "numberLock",
      "numberSort",
      "numberSortLock",
      "releaseDateLock",
      "summary",
      "summaryLock",
      "tags",
      "tagsLock",
      "title",
      "titleLock"
    ]
  },
  "BookMetadataUpdateDto": {
    "type": "object",
    "description": "Metadata fields to update. Set a field to null to unset the metadata. You can omit fields you don't want to update.",
    "properties": {
      "authors": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/AuthorUpdateDto"
        }
      },
      "authorsLock": {
        "type": "boolean"
      },
      "isbn": {
        "type": "string"
      },
      "isbnLock": {
        "type": "boolean"
      },
      "links": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WebLinkUpdateDto"
        }
      },
      "linksLock": {
        "type": "boolean"
      },
      "number": {
        "type": "string"
      },
      "numberLock": {
        "type": "boolean"
      },
      "numberSort": {
        "type": "number",
        "format": "float"
      },
      "numberSortLock": {
        "type": "boolean"
      },
      "releaseDate": {
        "type": "string",
        "format": "date"
      },
      "releaseDateLock": {
        "type": "boolean"
      },
      "summary": {
        "type": "string"
      },
      "summaryLock": {
        "type": "boolean"
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "tagsLock": {
        "type": "boolean"
      },
      "title": {
        "type": "string"
      },
      "titleLock": {
        "type": "boolean"
      }
    }
  },
  "BookSearch": {
    "type": "object",
    "properties": {
      "condition": {
        "$ref": "komga#/definitions/SearchConditionBook"
      },
      "fullTextSearch": {
        "type": "string"
      }
    }
  },
  "ClaimStatus": {
    "type": "object",
    "properties": {
      "isClaimed": {
        "type": "boolean"
      }
    },
    "required": [
      "isClaimed"
    ]
  },
  "ClientSettingDto": {
    "type": "object",
    "properties": {
      "allowUnauthorized": {
        "type": "boolean"
      },
      "value": {
        "type": "string"
      }
    },
    "required": [
      "value"
    ]
  },
  "ClientSettingGlobalUpdateDto": {
    "type": "object",
    "properties": {
      "allowUnauthorized": {
        "type": "boolean"
      },
      "value": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "allowUnauthorized",
      "value"
    ]
  },
  "ClientSettingUserUpdateDto": {
    "type": "object",
    "properties": {
      "value": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "value"
    ]
  },
  "CollectionCreationDto": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1
      },
      "ordered": {
        "type": "boolean"
      },
      "seriesIds": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "minItems": 1
      }
    },
    "required": [
      "name",
      "ordered",
      "seriesIds"
    ]
  },
  "CollectionDto": {
    "type": "object",
    "properties": {
      "createdDate": {
        "type": "string",
        "format": "date-time"
      },
      "filtered": {
        "type": "boolean"
      },
      "id": {
        "type": "string"
      },
      "lastModifiedDate": {
        "type": "string",
        "format": "date-time"
      },
      "name": {
        "type": "string"
      },
      "ordered": {
        "type": "boolean"
      },
      "seriesIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    },
    "required": [
      "createdDate",
      "filtered",
      "id",
      "lastModifiedDate",
      "name",
      "ordered",
      "seriesIds"
    ]
  },
  "CollectionUpdateDto": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string"
      },
      "ordered": {
        "type": "boolean"
      },
      "seriesIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    }
  },
  "DirectoryListingDto": {
    "type": "object",
    "properties": {
      "directories": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/PathDto"
        }
      },
      "files": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/PathDto"
        }
      },
      "parent": {
        "type": "string"
      }
    },
    "required": [
      "directories",
      "files"
    ]
  },
  "DirectoryRequestDto": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string"
      },
      "showFiles": {
        "type": "boolean"
      }
    },
    "required": [
      "path",
      "showFiles"
    ]
  },
  "GroupCountDto": {
    "type": "object",
    "properties": {
      "count": {
        "type": "integer",
        "format": "int32"
      },
      "group": {
        "type": "string"
      }
    },
    "required": [
      "count",
      "group"
    ]
  },
  "HistoricalEventDto": {
    "type": "object",
    "properties": {
      "bookId": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "properties": {
        "type": "object",
        "additionalProperties": {
          "type": "string"
        }
      },
      "seriesId": {
        "type": "string"
      },
      "timestamp": {
        "type": "string",
        "format": "date-time"
      },
      "type": {
        "type": "string"
      }
    },
    "required": [
      "id",
      "properties",
      "timestamp",
      "type"
    ]
  },
  "ItemAuthorDto": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Author's name",
        "example": "gotson"
      },
      "url": {
        "type": "string",
        "description": "URL of a site owned by the author",
        "example": "https://github.com/gotson"
      }
    }
  },
  "ItemDto": {
    "type": "object",
    "properties": {
      "_komga": {
        "$ref": "komga#/definitions/KomgaExtensionDto",
        "description": "Additional fields for the item"
      },
      "author": {
        "$ref": "komga#/definitions/ItemAuthorDto",
        "description": "Author of the item"
      },
      "content_html": {
        "type": "string",
        "description": "HTML of the item",
        "example": "<p>A longer text…</p>"
      },
      "date_modified": {
        "type": "string",
        "format": "date-time",
        "description": "Modification date in RFC 3339 format",
        "example": "2023-12-15T00:00:00Z"
      },
      "id": {
        "type": "string",
        "description": "Unique for that item for that feed over time",
        "example": "https://komga.org/blog/ebook-drop2"
      },
      "summary": {
        "type": "string",
        "description": "A plain text sentence or two describing the item",
        "example": "Version 1.9.0 contains the second feature drop for Ebooks support."
      },
      "tags": {
        "type": "array",
        "description": "Tags describing the item",
        "examples": [
          "upgrade",
          "komga"
        ],
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "title": {
        "type": "string",
        "description": "Plain text title",
        "example": "eBook drop 2"
      },
      "url": {
        "type": "string",
        "description": "URL of the resource described by the item",
        "example": "https://komga.org/blog/ebook-drop2"
      }
    },
    "required": [
      "id",
      "tags"
    ]
  },
  "JsonFeedDto": {
    "type": "object",
    "example": {
      "version": "https://jsonfeed.org/version/1",
      "title": "Announcements",
      "home_page_url": "https://komga.org/blog",
      "description": "Latest Komga announcements",
      "items": [
        {
          "id": "https://komga.org/blog/ebook-drop2",
          "url": "https://komga.org/blog/ebook-drop2",
          "title": "eBook drop 2",
          "summary": "Version 1.9.0 contains the second feature drop for Ebooks support.",
          "content_html": "<p>A longer text…</p>",
          "date_modified": "2023-12-15T00:00:00Z",
          "author": {
            "name": "gotson",
            "url": "https://github.com/gotson"
          },
          "tags": [
            "upgrade",
            "komga"
          ],
          "_komga": {
            "read": false
          }
        },
        {
          "id": "https://komga.org/blog/ebook-support",
          "url": "https://komga.org/blog/ebook-support",
          "title": "eBook support",
          "summary": "Version 1.8.0 is bringing a long awaited feature: proper eBook support!",
          "content_html": "<p>A longer text…</p>",
          "date_modified": "2023-11-29T00:00:00Z",
          "author": {
            "name": "gotson",
            "url": "https://github.com/gotson"
          },
          "tags": [
            "upgrade",
            "komga"
          ],
          "_komga": {
            "read": true
          }
        }
      ]
    },
    "properties": {
      "description": {
        "type": "string",
        "description": "Provides more detail on what the feed is about",
        "example": "Latest Komga announcements"
      },
      "home_page_url": {
        "type": "string",
        "description": "URL of the resource that the feed describes",
        "example": "https://komga.org/blog"
      },
      "items": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/ItemDto"
        }
      },
      "title": {
        "type": "string",
        "description": "Name of the feed",
        "example": "Announcements"
      },
      "version": {
        "type": "string",
        "description": "URL of the version of the format the feed uses",
        "example": "https://jsonfeed.org/version/1"
      }
    },
    "required": [
      "items",
      "title",
      "version"
    ]
  },
  "KomgaExtensionDto": {
    "type": "object",
    "properties": {
      "read": {
        "type": "boolean",
        "description": "Whether the current item has been marked read by the current user",
        "example": false
      }
    },
    "required": [
      "read"
    ]
  },
  "LibraryCreationDto": {
    "type": "object",
    "properties": {
      "analyzeDimensions": {
        "type": "boolean"
      },
      "convertToCbz": {
        "type": "boolean"
      },
      "emptyTrashAfterScan": {
        "type": "boolean"
      },
      "hashFiles": {
        "type": "boolean"
      },
      "hashKoreader": {
        "type": "boolean"
      },
      "hashPages": {
        "type": "boolean"
      },
      "importBarcodeIsbn": {
        "type": "boolean"
      },
      "importComicInfoBook": {
        "type": "boolean"
      },
      "importComicInfoCollection": {
        "type": "boolean"
      },
      "importComicInfoReadList": {
        "type": "boolean"
      },
      "importComicInfoSeries": {
        "type": "boolean"
      },
      "importComicInfoSeriesAppendVolume": {
        "type": "boolean"
      },
      "importEpubBook": {
        "type": "boolean"
      },
      "importEpubSeries": {
        "type": "boolean"
      },
      "importLocalArtwork": {
        "type": "boolean"
      },
      "importMylarSeries": {
        "type": "boolean"
      },
      "name": {
        "type": "string",
        "minLength": 1
      },
      "oneshotsDirectory": {
        "type": "string"
      },
      "repairExtensions": {
        "type": "boolean"
      },
      "root": {
        "type": "string",
        "minLength": 1
      },
      "scanCbx": {
        "type": "boolean"
      },
      "scanDirectoryExclusions": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "scanEpub": {
        "type": "boolean"
      },
      "scanForceModifiedTime": {
        "type": "boolean"
      },
      "scanInterval": {
        "type": "string",
        "enum": [
          "DISABLED",
          "HOURLY",
          "EVERY_6H",
          "EVERY_12H",
          "DAILY",
          "WEEKLY"
        ]
      },
      "scanOnStartup": {
        "type": "boolean"
      },
      "scanPdf": {
        "type": "boolean"
      },
      "seriesCover": {
        "type": "string",
        "enum": [
          "FIRST",
          "FIRST_UNREAD_OR_FIRST",
          "FIRST_UNREAD_OR_LAST",
          "LAST"
        ]
      }
    },
    "required": [
      "analyzeDimensions",
      "convertToCbz",
      "emptyTrashAfterScan",
      "hashFiles",
      "hashKoreader",
      "hashPages",
      "importBarcodeIsbn",
      "importComicInfoBook",
      "importComicInfoCollection",
      "importComicInfoReadList",
      "importComicInfoSeries",
      "importComicInfoSeriesAppendVolume",
      "importEpubBook",
      "importEpubSeries",
      "importLocalArtwork",
      "importMylarSeries",
      "name",
      "repairExtensions",
      "root",
      "scanCbx",
      "scanDirectoryExclusions",
      "scanEpub",
      "scanForceModifiedTime",
      "scanInterval",
      "scanOnStartup",
      "scanPdf",
      "seriesCover"
    ]
  },
  "LibraryDto": {
    "type": "object",
    "properties": {
      "analyzeDimensions": {
        "type": "boolean"
      },
      "convertToCbz": {
        "type": "boolean"
      },
      "emptyTrashAfterScan": {
        "type": "boolean"
      },
      "hashFiles": {
        "type": "boolean"
      },
      "hashKoreader": {
        "type": "boolean"
      },
      "hashPages": {
        "type": "boolean"
      },
      "id": {
        "type": "string"
      },
      "importBarcodeIsbn": {
        "type": "boolean"
      },
      "importComicInfoBook": {
        "type": "boolean"
      },
      "importComicInfoCollection": {
        "type": "boolean"
      },
      "importComicInfoReadList": {
        "type": "boolean"
      },
      "importComicInfoSeries": {
        "type": "boolean"
      },
      "importComicInfoSeriesAppendVolume": {
        "type": "boolean"
      },
      "importEpubBook": {
        "type": "boolean"
      },
      "importEpubSeries": {
        "type": "boolean"
      },
      "importLocalArtwork": {
        "type": "boolean"
      },
      "importMylarSeries": {
        "type": "boolean"
      },
      "name": {
        "type": "string"
      },
      "oneshotsDirectory": {
        "type": "string"
      },
      "repairExtensions": {
        "type": "boolean"
      },
      "root": {
        "type": "string"
      },
      "scanCbx": {
        "type": "boolean"
      },
      "scanDirectoryExclusions": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "scanEpub": {
        "type": "boolean"
      },
      "scanForceModifiedTime": {
        "type": "boolean"
      },
      "scanInterval": {
        "type": "string",
        "enum": [
          "DISABLED",
          "HOURLY",
          "EVERY_6H",
          "EVERY_12H",
          "DAILY",
          "WEEKLY"
        ]
      },
      "scanOnStartup": {
        "type": "boolean"
      },
      "scanPdf": {
        "type": "boolean"
      },
      "seriesCover": {
        "type": "string",
        "enum": [
          "FIRST",
          "FIRST_UNREAD_OR_FIRST",
          "FIRST_UNREAD_OR_LAST",
          "LAST"
        ]
      },
      "unavailable": {
        "type": "boolean"
      }
    },
    "required": [
      "analyzeDimensions",
      "convertToCbz",
      "emptyTrashAfterScan",
      "hashFiles",
      "hashKoreader",
      "hashPages",
      "id",
      "importBarcodeIsbn",
      "importComicInfoBook",
      "importComicInfoCollection",
      "importComicInfoReadList",
      "importComicInfoSeries",
      "importComicInfoSeriesAppendVolume",
      "importEpubBook",
      "importEpubSeries",
      "importLocalArtwork",
      "importMylarSeries",
      "name",
      "repairExtensions",
      "root",
      "scanCbx",
      "scanDirectoryExclusions",
      "scanEpub",
      "scanForceModifiedTime",
      "scanInterval",
      "scanOnStartup",
      "scanPdf",
      "seriesCover",
      "unavailable"
    ]
  },
  "LibraryUpdateDto": {
    "type": "object",
    "description": "Fields to update. You can omit fields you don't want to update.",
    "properties": {
      "analyzeDimensions": {
        "type": "boolean"
      },
      "convertToCbz": {
        "type": "boolean"
      },
      "emptyTrashAfterScan": {
        "type": "boolean"
      },
      "hashFiles": {
        "type": "boolean"
      },
      "hashKoreader": {
        "type": "boolean"
      },
      "hashPages": {
        "type": "boolean"
      },
      "importBarcodeIsbn": {
        "type": "boolean"
      },
      "importComicInfoBook": {
        "type": "boolean"
      },
      "importComicInfoCollection": {
        "type": "boolean"
      },
      "importComicInfoReadList": {
        "type": "boolean"
      },
      "importComicInfoSeries": {
        "type": "boolean"
      },
      "importComicInfoSeriesAppendVolume": {
        "type": "boolean"
      },
      "importEpubBook": {
        "type": "boolean"
      },
      "importEpubSeries": {
        "type": "boolean"
      },
      "importLocalArtwork": {
        "type": "boolean"
      },
      "importMylarSeries": {
        "type": "boolean"
      },
      "name": {
        "type": "string"
      },
      "oneshotsDirectory": {
        "type": "string"
      },
      "repairExtensions": {
        "type": "boolean"
      },
      "root": {
        "type": "string"
      },
      "scanCbx": {
        "type": "boolean"
      },
      "scanDirectoryExclusions": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "scanEpub": {
        "type": "boolean"
      },
      "scanForceModifiedTime": {
        "type": "boolean"
      },
      "scanInterval": {
        "type": "string",
        "enum": [
          "DISABLED",
          "HOURLY",
          "EVERY_6H",
          "EVERY_12H",
          "DAILY",
          "WEEKLY"
        ]
      },
      "scanOnStartup": {
        "type": "boolean"
      },
      "scanPdf": {
        "type": "boolean"
      },
      "seriesCover": {
        "type": "string",
        "enum": [
          "FIRST",
          "FIRST_UNREAD_OR_FIRST",
          "FIRST_UNREAD_OR_LAST",
          "LAST"
        ]
      }
    }
  },
  "Location": {
    "type": "object",
    "properties": {
      "fragments": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "position": {
        "type": "integer",
        "format": "int32"
      },
      "progression": {
        "type": "number",
        "format": "float"
      },
      "totalProgression": {
        "type": "number",
        "format": "float"
      }
    },
    "required": [
      "fragments"
    ]
  },
  "MediaDto": {
    "type": "object",
    "properties": {
      "comment": {
        "type": "string"
      },
      "epubDivinaCompatible": {
        "type": "boolean"
      },
      "epubIsKepub": {
        "type": "boolean"
      },
      "mediaProfile": {
        "type": "string"
      },
      "mediaType": {
        "type": "string"
      },
      "pagesCount": {
        "type": "integer",
        "format": "int32"
      },
      "status": {
        "type": "string"
      }
    },
    "required": [
      "comment",
      "epubDivinaCompatible",
      "epubIsKepub",
      "mediaProfile",
      "mediaType",
      "pagesCount",
      "status"
    ]
  },
  "MediaType": {
    "type": "object",
    "properties": {
      "charset": {
        "type": "string"
      },
      "concrete": {
        "type": "boolean"
      },
      "parameters": {
        "type": "object",
        "additionalProperties": {
          "type": "string"
        }
      },
      "qualityValue": {
        "type": "number",
        "format": "double"
      },
      "subtype": {
        "type": "string"
      },
      "subtypeSuffix": {
        "type": "string"
      },
      "type": {
        "type": "string"
      },
      "wildcardSubtype": {
        "type": "boolean"
      },
      "wildcardType": {
        "type": "boolean"
      }
    }
  },
  "OAuth2ClientDto": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string"
      },
      "registrationId": {
        "type": "string"
      }
    },
    "required": [
      "name",
      "registrationId"
    ]
  },
  "PageAuthenticationActivityDto": {
    "type": "object",
    "properties": {
      "content": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/AuthenticationActivityDto"
        }
      },
      "empty": {
        "type": "boolean"
      },
      "first": {
        "type": "boolean"
      },
      "last": {
        "type": "boolean"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "numberOfElements": {
        "type": "integer",
        "format": "int32"
      },
      "pageable": {
        "$ref": "komga#/definitions/PageableObject"
      },
      "size": {
        "type": "integer",
        "format": "int32"
      },
      "sort": {
        "$ref": "komga#/definitions/SortObject"
      },
      "totalElements": {
        "type": "integer",
        "format": "int64"
      },
      "totalPages": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "PageAuthorDto": {
    "type": "object",
    "properties": {
      "content": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/AuthorDto"
        }
      },
      "empty": {
        "type": "boolean"
      },
      "first": {
        "type": "boolean"
      },
      "last": {
        "type": "boolean"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "numberOfElements": {
        "type": "integer",
        "format": "int32"
      },
      "pageable": {
        "$ref": "komga#/definitions/PageableObject"
      },
      "size": {
        "type": "integer",
        "format": "int32"
      },
      "sort": {
        "$ref": "komga#/definitions/SortObject"
      },
      "totalElements": {
        "type": "integer",
        "format": "int64"
      },
      "totalPages": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "PageBookDto": {
    "type": "object",
    "properties": {
      "content": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/BookDto"
        }
      },
      "empty": {
        "type": "boolean"
      },
      "first": {
        "type": "boolean"
      },
      "last": {
        "type": "boolean"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "numberOfElements": {
        "type": "integer",
        "format": "int32"
      },
      "pageable": {
        "$ref": "komga#/definitions/PageableObject"
      },
      "size": {
        "type": "integer",
        "format": "int32"
      },
      "sort": {
        "$ref": "komga#/definitions/SortObject"
      },
      "totalElements": {
        "type": "integer",
        "format": "int64"
      },
      "totalPages": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "PageCollectionDto": {
    "type": "object",
    "properties": {
      "content": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/CollectionDto"
        }
      },
      "empty": {
        "type": "boolean"
      },
      "first": {
        "type": "boolean"
      },
      "last": {
        "type": "boolean"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "numberOfElements": {
        "type": "integer",
        "format": "int32"
      },
      "pageable": {
        "$ref": "komga#/definitions/PageableObject"
      },
      "size": {
        "type": "integer",
        "format": "int32"
      },
      "sort": {
        "$ref": "komga#/definitions/SortObject"
      },
      "totalElements": {
        "type": "integer",
        "format": "int64"
      },
      "totalPages": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "PageDto": {
    "type": "object",
    "properties": {
      "fileName": {
        "type": "string"
      },
      "height": {
        "type": "integer",
        "format": "int32"
      },
      "mediaType": {
        "type": "string"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "size": {
        "type": "string"
      },
      "sizeBytes": {
        "type": "integer",
        "format": "int64"
      },
      "width": {
        "type": "integer",
        "format": "int32"
      }
    },
    "required": [
      "fileName",
      "mediaType",
      "number",
      "size"
    ]
  },
  "PageHashCreationDto": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "DELETE_AUTO",
          "DELETE_MANUAL",
          "IGNORE"
        ]
      },
      "hash": {
        "type": "string",
        "minLength": 1
      },
      "size": {
        "type": "integer",
        "format": "int64"
      }
    },
    "required": [
      "action",
      "hash"
    ]
  },
  "PageHashKnownDto": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "DELETE_AUTO",
          "DELETE_MANUAL",
          "IGNORE"
        ]
      },
      "created": {
        "type": "string",
        "format": "date-time"
      },
      "deleteCount": {
        "type": "integer",
        "format": "int32"
      },
      "hash": {
        "type": "string"
      },
      "lastModified": {
        "type": "string",
        "format": "date-time"
      },
      "matchCount": {
        "type": "integer",
        "format": "int32"
      },
      "size": {
        "type": "integer",
        "format": "int64"
      }
    },
    "required": [
      "action",
      "created",
      "deleteCount",
      "hash",
      "lastModified",
      "matchCount"
    ]
  },
  "PageHashMatchDto": {
    "type": "object",
    "properties": {
      "bookId": {
        "type": "string"
      },
      "fileName": {
        "type": "string"
      },
      "fileSize": {
        "type": "integer",
        "format": "int64"
      },
      "mediaType": {
        "type": "string"
      },
      "pageNumber": {
        "type": "integer",
        "format": "int32"
      },
      "url": {
        "type": "string"
      }
    },
    "required": [
      "bookId",
      "fileName",
      "fileSize",
      "mediaType",
      "pageNumber",
      "url"
    ]
  },
  "PageHashUnknownDto": {
    "type": "object",
    "properties": {
      "hash": {
        "type": "string"
      },
      "matchCount": {
        "type": "integer",
        "format": "int32"
      },
      "size": {
        "type": "integer",
        "format": "int64"
      }
    },
    "required": [
      "hash",
      "matchCount"
    ]
  },
  "PageHistoricalEventDto": {
    "type": "object",
    "properties": {
      "content": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/HistoricalEventDto"
        }
      },
      "empty": {
        "type": "boolean"
      },
      "first": {
        "type": "boolean"
      },
      "last": {
        "type": "boolean"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "numberOfElements": {
        "type": "integer",
        "format": "int32"
      },
      "pageable": {
        "$ref": "komga#/definitions/PageableObject"
      },
      "size": {
        "type": "integer",
        "format": "int32"
      },
      "sort": {
        "$ref": "komga#/definitions/SortObject"
      },
      "totalElements": {
        "type": "integer",
        "format": "int64"
      },
      "totalPages": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "PageInteger": {
    "type": "object",
    "properties": {
      "content": {
        "type": "array",
        "items": {
          "type": "integer",
          "format": "int32"
        }
      },
      "empty": {
        "type": "boolean"
      },
      "first": {
        "type": "boolean"
      },
      "last": {
        "type": "boolean"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "numberOfElements": {
        "type": "integer",
        "format": "int32"
      },
      "pageable": {
        "$ref": "komga#/definitions/PageableObject"
      },
      "size": {
        "type": "integer",
        "format": "int32"
      },
      "sort": {
        "$ref": "komga#/definitions/SortObject"
      },
      "totalElements": {
        "type": "integer",
        "format": "int64"
      },
      "totalPages": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "PagePageHashKnownDto": {
    "type": "object",
    "properties": {
      "content": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/PageHashKnownDto"
        }
      },
      "empty": {
        "type": "boolean"
      },
      "first": {
        "type": "boolean"
      },
      "last": {
        "type": "boolean"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "numberOfElements": {
        "type": "integer",
        "format": "int32"
      },
      "pageable": {
        "$ref": "komga#/definitions/PageableObject"
      },
      "size": {
        "type": "integer",
        "format": "int32"
      },
      "sort": {
        "$ref": "komga#/definitions/SortObject"
      },
      "totalElements": {
        "type": "integer",
        "format": "int64"
      },
      "totalPages": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "PagePageHashMatchDto": {
    "type": "object",
    "properties": {
      "content": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/PageHashMatchDto"
        }
      },
      "empty": {
        "type": "boolean"
      },
      "first": {
        "type": "boolean"
      },
      "last": {
        "type": "boolean"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "numberOfElements": {
        "type": "integer",
        "format": "int32"
      },
      "pageable": {
        "$ref": "komga#/definitions/PageableObject"
      },
      "size": {
        "type": "integer",
        "format": "int32"
      },
      "sort": {
        "$ref": "komga#/definitions/SortObject"
      },
      "totalElements": {
        "type": "integer",
        "format": "int64"
      },
      "totalPages": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "PagePageHashUnknownDto": {
    "type": "object",
    "properties": {
      "content": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/PageHashUnknownDto"
        }
      },
      "empty": {
        "type": "boolean"
      },
      "first": {
        "type": "boolean"
      },
      "last": {
        "type": "boolean"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "numberOfElements": {
        "type": "integer",
        "format": "int32"
      },
      "pageable": {
        "$ref": "komga#/definitions/PageableObject"
      },
      "size": {
        "type": "integer",
        "format": "int32"
      },
      "sort": {
        "$ref": "komga#/definitions/SortObject"
      },
      "totalElements": {
        "type": "integer",
        "format": "int64"
      },
      "totalPages": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "PageReadListDto": {
    "type": "object",
    "properties": {
      "content": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/ReadListDto"
        }
      },
      "empty": {
        "type": "boolean"
      },
      "first": {
        "type": "boolean"
      },
      "last": {
        "type": "boolean"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "numberOfElements": {
        "type": "integer",
        "format": "int32"
      },
      "pageable": {
        "$ref": "komga#/definitions/PageableObject"
      },
      "size": {
        "type": "integer",
        "format": "int32"
      },
      "sort": {
        "$ref": "komga#/definitions/SortObject"
      },
      "totalElements": {
        "type": "integer",
        "format": "int64"
      },
      "totalPages": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "PageSeriesDto": {
    "type": "object",
    "properties": {
      "content": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/SeriesDto"
        }
      },
      "empty": {
        "type": "boolean"
      },
      "first": {
        "type": "boolean"
      },
      "last": {
        "type": "boolean"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "numberOfElements": {
        "type": "integer",
        "format": "int32"
      },
      "pageable": {
        "$ref": "komga#/definitions/PageableObject"
      },
      "size": {
        "type": "integer",
        "format": "int32"
      },
      "sort": {
        "$ref": "komga#/definitions/SortObject"
      },
      "totalElements": {
        "type": "integer",
        "format": "int64"
      },
      "totalPages": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "PageString": {
    "type": "object",
    "properties": {
      "content": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "empty": {
        "type": "boolean"
      },
      "first": {
        "type": "boolean"
      },
      "last": {
        "type": "boolean"
      },
      "number": {
        "type": "integer",
        "format": "int32"
      },
      "numberOfElements": {
        "type": "integer",
        "format": "int32"
      },
      "pageable": {
        "$ref": "komga#/definitions/PageableObject"
      },
      "size": {
        "type": "integer",
        "format": "int32"
      },
      "sort": {
        "$ref": "komga#/definitions/SortObject"
      },
      "totalElements": {
        "type": "integer",
        "format": "int64"
      },
      "totalPages": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "PageableObject": {
    "type": "object",
    "properties": {
      "offset": {
        "type": "integer",
        "format": "int64"
      },
      "pageNumber": {
        "type": "integer",
        "format": "int32"
      },
      "pageSize": {
        "type": "integer",
        "format": "int32"
      },
      "paged": {
        "type": "boolean"
      },
      "sort": {
        "$ref": "komga#/definitions/SortObject"
      },
      "unpaged": {
        "type": "boolean"
      }
    }
  },
  "PasswordUpdateDto": {
    "type": "object",
    "properties": {
      "password": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "password"
    ]
  },
  "PathDto": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string"
      },
      "path": {
        "type": "string"
      },
      "type": {
        "type": "string"
      }
    },
    "required": [
      "name",
      "path",
      "type"
    ]
  },
  "R2Device": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "name": {
        "type": "string"
      }
    },
    "required": [
      "id",
      "name"
    ]
  },
  "R2Locator": {
    "type": "object",
    "properties": {
      "href": {
        "type": "string"
      },
      "koboSpan": {
        "type": "string"
      },
      "locations": {
        "$ref": "komga#/definitions/Location"
      },
      "text": {
        "$ref": "komga#/definitions/Text"
      },
      "title": {
        "type": "string"
      },
      "type": {
        "type": "string"
      }
    },
    "required": [
      "href",
      "type"
    ]
  },
  "R2Positions": {
    "type": "object",
    "properties": {
      "positions": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/R2Locator"
        }
      },
      "total": {
        "type": "integer",
        "format": "int32"
      }
    },
    "required": [
      "positions",
      "total"
    ]
  },
  "R2Progression": {
    "type": "object",
    "properties": {
      "device": {
        "$ref": "komga#/definitions/R2Device"
      },
      "locator": {
        "$ref": "komga#/definitions/R2Locator"
      },
      "modified": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "device",
      "locator",
      "modified"
    ]
  },
  "ReadListCreationDto": {
    "type": "object",
    "properties": {
      "bookIds": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "minItems": 1
      },
      "name": {
        "type": "string",
        "minLength": 1
      },
      "ordered": {
        "type": "boolean"
      },
      "summary": {
        "type": "string"
      }
    },
    "required": [
      "bookIds",
      "name",
      "ordered",
      "summary"
    ]
  },
  "ReadListDto": {
    "type": "object",
    "properties": {
      "bookIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "createdDate": {
        "type": "string",
        "format": "date-time"
      },
      "filtered": {
        "type": "boolean"
      },
      "id": {
        "type": "string"
      },
      "lastModifiedDate": {
        "type": "string",
        "format": "date-time"
      },
      "name": {
        "type": "string"
      },
      "ordered": {
        "type": "boolean"
      },
      "summary": {
        "type": "string"
      }
    },
    "required": [
      "bookIds",
      "createdDate",
      "filtered",
      "id",
      "lastModifiedDate",
      "name",
      "ordered",
      "summary"
    ]
  },
  "ReadListMatchDto": {
    "type": "object",
    "properties": {
      "errorCode": {
        "type": "string"
      },
      "name": {
        "type": "string"
      }
    },
    "required": [
      "errorCode",
      "name"
    ]
  },
  "ReadListRequestBookDto": {
    "type": "object",
    "properties": {
      "number": {
        "type": "string"
      },
      "series": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      }
    },
    "required": [
      "number",
      "series"
    ]
  },
  "ReadListRequestBookMatchBookDto": {
    "type": "object",
    "properties": {
      "bookId": {
        "type": "string"
      },
      "number": {
        "type": "string"
      },
      "title": {
        "type": "string"
      }
    },
    "required": [
      "bookId",
      "number",
      "title"
    ]
  },
  "ReadListRequestBookMatchDto": {
    "type": "object",
    "properties": {
      "books": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/ReadListRequestBookMatchBookDto"
        }
      },
      "series": {
        "$ref": "komga#/definitions/ReadListRequestBookMatchSeriesDto"
      }
    },
    "required": [
      "books",
      "series"
    ]
  },
  "ReadListRequestBookMatchSeriesDto": {
    "type": "object",
    "properties": {
      "releaseDate": {
        "type": "string",
        "format": "date"
      },
      "seriesId": {
        "type": "string"
      },
      "title": {
        "type": "string"
      }
    },
    "required": [
      "seriesId",
      "title"
    ]
  },
  "ReadListRequestBookMatchesDto": {
    "type": "object",
    "properties": {
      "matches": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/ReadListRequestBookMatchDto"
        }
      },
      "request": {
        "$ref": "komga#/definitions/ReadListRequestBookDto"
      }
    },
    "required": [
      "matches",
      "request"
    ]
  },
  "ReadListRequestMatchDto": {
    "type": "object",
    "properties": {
      "errorCode": {
        "type": "string"
      },
      "readListMatch": {
        "$ref": "komga#/definitions/ReadListMatchDto"
      },
      "requests": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/ReadListRequestBookMatchesDto"
        }
      }
    },
    "required": [
      "errorCode",
      "readListMatch",
      "requests"
    ]
  },
  "ReadListUpdateDto": {
    "type": "object",
    "properties": {
      "bookIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "name": {
        "type": "string"
      },
      "ordered": {
        "type": "boolean"
      },
      "summary": {
        "type": "string"
      }
    }
  },
  "ReadProgressDto": {
    "type": "object",
    "properties": {
      "completed": {
        "type": "boolean"
      },
      "created": {
        "type": "string",
        "format": "date-time"
      },
      "deviceId": {
        "type": "string"
      },
      "deviceName": {
        "type": "string"
      },
      "lastModified": {
        "type": "string",
        "format": "date-time"
      },
      "page": {
        "type": "integer",
        "format": "int32"
      },
      "readDate": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "completed",
      "created",
      "deviceId",
      "deviceName",
      "lastModified",
      "page",
      "readDate"
    ]
  },
  "ReadProgressUpdateDto": {
    "type": "object",
    "description": "page can be omitted if completed is set to true. completed can be omitted, and will be set accordingly depending on the page passed and the total number of pages in the book.",
    "properties": {
      "completed": {
        "type": "boolean"
      },
      "page": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "ReleaseDto": {
    "type": "object",
    "properties": {
      "description": {
        "type": "string"
      },
      "latest": {
        "type": "boolean"
      },
      "preRelease": {
        "type": "boolean"
      },
      "releaseDate": {
        "type": "string",
        "format": "date-time"
      },
      "url": {
        "type": "string"
      },
      "version": {
        "type": "string"
      }
    },
    "required": [
      "description",
      "latest",
      "preRelease",
      "releaseDate",
      "url",
      "version"
    ]
  },
  "ScanRequestDto": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string"
      }
    },
    "required": [
      "path"
    ]
  },
  "SearchConditionAgeRating": {
    "properties": {
      "ageRating": {
        "$ref": "komga#/definitions/SearchOperatorNumericNullableInteger"
      }
    },
    "required": [
      "ageRating"
    ]
  },
  "SearchConditionAllOfBook": {
    "properties": {
      "allOf": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/SearchConditionBook"
        }
      }
    },
    "required": [
      "allOf"
    ]
  },
  "SearchConditionAllOfSeries": {
    "properties": {
      "allOf": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/SearchConditionSeries"
        }
      }
    },
    "required": [
      "allOf"
    ]
  },
  "SearchConditionAnyOfBook": {
    "properties": {
      "anyOf": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/SearchConditionBook"
        }
      }
    },
    "required": [
      "anyOf"
    ]
  },
  "SearchConditionAnyOfSeries": {
    "properties": {
      "anyOf": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/SearchConditionSeries"
        }
      }
    },
    "required": [
      "anyOf"
    ]
  },
  "SearchConditionAuthor": {
    "properties": {
      "author": {
        "$ref": "komga#/definitions/SearchOperatorEqualityAuthorMatch"
      }
    },
    "required": [
      "author"
    ]
  },
  "SearchConditionBook": {
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchConditionAnyOfBook"
      },
      {
        "$ref": "komga#/definitions/SearchConditionAllOfBook"
      },
      {
        "$ref": "komga#/definitions/SearchConditionLibraryId"
      },
      {
        "$ref": "komga#/definitions/SearchConditionReadListId"
      },
      {
        "$ref": "komga#/definitions/SearchConditionSeriesId"
      },
      {
        "$ref": "komga#/definitions/SearchConditionDeleted"
      },
      {
        "$ref": "komga#/definitions/SearchConditionOneShot"
      },
      {
        "$ref": "komga#/definitions/SearchConditionTitle"
      },
      {
        "$ref": "komga#/definitions/SearchConditionReleaseDate"
      },
      {
        "$ref": "komga#/definitions/SearchConditionTag"
      },
      {
        "$ref": "komga#/definitions/SearchConditionNumberSort"
      },
      {
        "$ref": "komga#/definitions/SearchConditionReadStatus"
      },
      {
        "$ref": "komga#/definitions/SearchConditionMediaStatus"
      },
      {
        "$ref": "komga#/definitions/SearchConditionMediaProfile"
      },
      {
        "$ref": "komga#/definitions/SearchConditionAuthor"
      },
      {
        "$ref": "komga#/definitions/SearchConditionPoster"
      }
    ]
  },
  "SearchConditionCollectionId": {
    "properties": {
      "collectionId": {
        "$ref": "komga#/definitions/SearchOperatorEqualityString"
      }
    },
    "required": [
      "collectionId"
    ]
  },
  "SearchConditionComplete": {
    "properties": {
      "complete": {
        "$ref": "komga#/definitions/SearchOperatorBoolean"
      }
    },
    "required": [
      "complete"
    ]
  },
  "SearchConditionDeleted": {
    "properties": {
      "deleted": {
        "$ref": "komga#/definitions/SearchOperatorBoolean"
      }
    },
    "required": [
      "deleted"
    ]
  },
  "SearchConditionGenre": {
    "properties": {
      "genre": {
        "$ref": "komga#/definitions/SearchOperatorEqualityNullableString"
      }
    },
    "required": [
      "genre"
    ]
  },
  "SearchConditionLanguage": {
    "properties": {
      "language": {
        "$ref": "komga#/definitions/SearchOperatorEqualityString"
      }
    },
    "required": [
      "language"
    ]
  },
  "SearchConditionLibraryId": {
    "properties": {
      "libraryId": {
        "$ref": "komga#/definitions/SearchOperatorEqualityString"
      }
    },
    "required": [
      "libraryId"
    ]
  },
  "SearchConditionMediaProfile": {
    "properties": {
      "mediaProfile": {
        "$ref": "komga#/definitions/SearchOperatorEqualityMediaProfile"
      }
    },
    "required": [
      "mediaProfile"
    ]
  },
  "SearchConditionMediaStatus": {
    "properties": {
      "mediaStatus": {
        "$ref": "komga#/definitions/SearchOperatorEqualityStatus"
      }
    },
    "required": [
      "mediaStatus"
    ]
  },
  "SearchConditionNumberSort": {
    "properties": {
      "numberSort": {
        "$ref": "komga#/definitions/SearchOperatorNumericTFloat"
      }
    },
    "required": [
      "numberSort"
    ]
  },
  "SearchConditionOneShot": {
    "properties": {
      "oneShot": {
        "$ref": "komga#/definitions/SearchOperatorBoolean"
      }
    },
    "required": [
      "oneShot"
    ]
  },
  "SearchConditionPoster": {
    "properties": {
      "poster": {
        "$ref": "komga#/definitions/SearchOperatorEqualityPosterMatch"
      }
    },
    "required": [
      "poster"
    ]
  },
  "SearchConditionPublisher": {
    "properties": {
      "publisher": {
        "$ref": "komga#/definitions/SearchOperatorEqualityString"
      }
    },
    "required": [
      "publisher"
    ]
  },
  "SearchConditionReadListId": {
    "properties": {
      "readListId": {
        "$ref": "komga#/definitions/SearchOperatorEqualityString"
      }
    },
    "required": [
      "readListId"
    ]
  },
  "SearchConditionReadStatus": {
    "properties": {
      "readStatus": {
        "$ref": "komga#/definitions/SearchOperatorEqualityReadStatus"
      }
    },
    "required": [
      "readStatus"
    ]
  },
  "SearchConditionReleaseDate": {
    "properties": {
      "releaseDate": {
        "$ref": "komga#/definitions/SearchOperatorDate"
      }
    },
    "required": [
      "releaseDate"
    ]
  },
  "SearchConditionSeries": {
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchConditionAnyOfSeries"
      },
      {
        "$ref": "komga#/definitions/SearchConditionAllOfSeries"
      },
      {
        "$ref": "komga#/definitions/SearchConditionLibraryId"
      },
      {
        "$ref": "komga#/definitions/SearchConditionCollectionId"
      },
      {
        "$ref": "komga#/definitions/SearchConditionDeleted"
      },
      {
        "$ref": "komga#/definitions/SearchConditionComplete"
      },
      {
        "$ref": "komga#/definitions/SearchConditionOneShot"
      },
      {
        "$ref": "komga#/definitions/SearchConditionTitle"
      },
      {
        "$ref": "komga#/definitions/SearchConditionTitleSort"
      },
      {
        "$ref": "komga#/definitions/SearchConditionReleaseDate"
      },
      {
        "$ref": "komga#/definitions/SearchConditionTag"
      },
      {
        "$ref": "komga#/definitions/SearchConditionSharingLabel"
      },
      {
        "$ref": "komga#/definitions/SearchConditionPublisher"
      },
      {
        "$ref": "komga#/definitions/SearchConditionLanguage"
      },
      {
        "$ref": "komga#/definitions/SearchConditionGenre"
      },
      {
        "$ref": "komga#/definitions/SearchConditionAgeRating"
      },
      {
        "$ref": "komga#/definitions/SearchConditionReadStatus"
      },
      {
        "$ref": "komga#/definitions/SearchConditionSeriesStatus"
      },
      {
        "$ref": "komga#/definitions/SearchConditionAuthor"
      }
    ]
  },
  "SearchConditionSeriesId": {
    "properties": {
      "seriesId": {
        "$ref": "komga#/definitions/SearchOperatorEqualityString"
      }
    },
    "required": [
      "seriesId"
    ]
  },
  "SearchConditionSeriesStatus": {
    "properties": {
      "seriesStatus": {
        "$ref": "komga#/definitions/SearchOperatorEqualityStatus"
      }
    },
    "required": [
      "seriesStatus"
    ]
  },
  "SearchConditionSharingLabel": {
    "properties": {
      "sharingLabel": {
        "$ref": "komga#/definitions/SearchOperatorEqualityNullableString"
      }
    },
    "required": [
      "sharingLabel"
    ]
  },
  "SearchConditionTag": {
    "properties": {
      "tag": {
        "$ref": "komga#/definitions/SearchOperatorEqualityNullableString"
      }
    },
    "required": [
      "tag"
    ]
  },
  "SearchConditionTitle": {
    "properties": {
      "title": {
        "$ref": "komga#/definitions/SearchOperatorString"
      }
    },
    "required": [
      "title"
    ]
  },
  "SearchConditionTitleSort": {
    "properties": {
      "titleSort": {
        "$ref": "komga#/definitions/SearchOperatorString"
      }
    },
    "required": [
      "titleSort"
    ]
  },
  "SearchOperatorAfter": {
    "properties": {
      "dateTime": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "dateTime"
    ]
  },
  "SearchOperatorBefore": {
    "properties": {
      "dateTime": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "dateTime"
    ]
  },
  "SearchOperatorBeginsWith": {
    "properties": {
      "value": {
        "type": "string"
      }
    },
    "required": [
      "value"
    ]
  },
  "SearchOperatorBoolean": {
    "discriminator": {
      "mapping": {
        "isFalse": "#/components/schemas/SearchOperatorIsFalse",
        "isTrue": "#/components/schemas/SearchOperatorIsTrue"
      },
      "propertyName": "operator"
    },
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorIsTrue"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsFalse"
      }
    ],
    "properties": {
      "operator": {
        "type": "string"
      }
    },
    "required": [
      "operator"
    ]
  },
  "SearchOperatorContains": {
    "properties": {
      "value": {
        "type": "string"
      }
    },
    "required": [
      "value"
    ]
  },
  "SearchOperatorDate": {
    "discriminator": {
      "mapping": {
        "after": "#/components/schemas/SearchOperatorAfter",
        "before": "#/components/schemas/SearchOperatorBefore",
        "isInTheLast": "#/components/schemas/SearchOperatorIsInTheLast",
        "isNotInTheLast": "#/components/schemas/SearchOperatorIsNotInTheLast",
        "isNotNull": "#/components/schemas/SearchOperatorIsNotNull",
        "isNull": "#/components/schemas/SearchOperatorIsNull"
      },
      "propertyName": "operator"
    },
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorBefore"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorAfter"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsInTheLast"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNotInTheLast"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNull"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNotNull"
      }
    ],
    "properties": {
      "operator": {
        "type": "string"
      }
    },
    "required": [
      "operator"
    ]
  },
  "SearchOperatorDoesNotBeginWith": {
    "properties": {
      "value": {
        "type": "string"
      }
    },
    "required": [
      "value"
    ]
  },
  "SearchOperatorDoesNotContain": {
    "properties": {
      "value": {
        "type": "string"
      }
    },
    "required": [
      "value"
    ]
  },
  "SearchOperatorDoesNotEndWith": {
    "properties": {
      "value": {
        "type": "string"
      }
    },
    "required": [
      "value"
    ]
  },
  "SearchOperatorEndsWith": {
    "properties": {
      "value": {
        "type": "string"
      }
    },
    "required": [
      "value"
    ]
  },
  "SearchOperatorEqualityAuthorMatch": {
    "discriminator": {
      "mapping": {
        "is": "#/components/schemas/SearchOperatorIs",
        "isNot": "#/components/schemas/SearchOperatorIsNot"
      },
      "propertyName": "operator"
    },
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorIs"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNot"
      }
    ],
    "properties": {
      "operator": {
        "type": "string"
      }
    },
    "required": [
      "operator"
    ]
  },
  "SearchOperatorEqualityMediaProfile": {
    "discriminator": {
      "mapping": {
        "is": "#/components/schemas/SearchOperatorIs",
        "isNot": "#/components/schemas/SearchOperatorIsNot"
      },
      "propertyName": "operator"
    },
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorIs"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNot"
      }
    ],
    "properties": {
      "operator": {
        "type": "string"
      }
    },
    "required": [
      "operator"
    ]
  },
  "SearchOperatorEqualityNullableString": {
    "discriminator": {
      "mapping": {
        "is": "#/components/schemas/SearchOperatorIs",
        "isNot": "#/components/schemas/SearchOperatorIsNot",
        "isNotNull": "#/components/schemas/SearchOperatorIsNotNullT",
        "isNull": "#/components/schemas/SearchOperatorIsNullT"
      },
      "propertyName": "operator"
    },
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorIs"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNot"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNullT"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNotNullT"
      }
    ],
    "properties": {
      "operator": {
        "type": "string"
      }
    },
    "required": [
      "operator"
    ]
  },
  "SearchOperatorEqualityPosterMatch": {
    "discriminator": {
      "mapping": {
        "is": "#/components/schemas/SearchOperatorIs",
        "isNot": "#/components/schemas/SearchOperatorIsNot"
      },
      "propertyName": "operator"
    },
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorIs"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNot"
      }
    ],
    "properties": {
      "operator": {
        "type": "string"
      }
    },
    "required": [
      "operator"
    ]
  },
  "SearchOperatorEqualityReadStatus": {
    "discriminator": {
      "mapping": {
        "is": "#/components/schemas/SearchOperatorIs",
        "isNot": "#/components/schemas/SearchOperatorIsNot"
      },
      "propertyName": "operator"
    },
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorIs"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNot"
      }
    ],
    "properties": {
      "operator": {
        "type": "string"
      }
    },
    "required": [
      "operator"
    ]
  },
  "SearchOperatorEqualityStatus": {
    "discriminator": {
      "mapping": {
        "is": "#/components/schemas/SearchOperatorIs",
        "isNot": "#/components/schemas/SearchOperatorIsNot"
      },
      "propertyName": "operator"
    },
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorIs"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNot"
      }
    ],
    "properties": {
      "operator": {
        "type": "string"
      }
    },
    "required": [
      "operator"
    ]
  },
  "SearchOperatorEqualityString": {
    "discriminator": {
      "mapping": {
        "is": "#/components/schemas/SearchOperatorIs",
        "isNot": "#/components/schemas/SearchOperatorIsNot"
      },
      "propertyName": "operator"
    },
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorIs"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNot"
      }
    ],
    "properties": {
      "operator": {
        "type": "string"
      }
    },
    "required": [
      "operator"
    ]
  },
  "SearchOperatorGreaterThan": {
    "properties": {
      "value": {}
    },
    "required": [
      "value"
    ]
  },
  "SearchOperatorIs": {
    "properties": {
      "value": {}
    },
    "required": [
      "value"
    ]
  },
  "SearchOperatorIsFalse": {
    "allOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorBoolean"
      }
    ]
  },
  "SearchOperatorIsInTheLast": {
    "properties": {
      "duration": {
        "type": "string"
      }
    },
    "required": [
      "duration"
    ]
  },
  "SearchOperatorIsNot": {
    "properties": {
      "value": {}
    },
    "required": [
      "value"
    ]
  },
  "SearchOperatorIsNotInTheLast": {
    "properties": {
      "duration": {
        "type": "string"
      }
    },
    "required": [
      "duration"
    ]
  },
  "SearchOperatorIsNotNull": {
    "allOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorDate"
      }
    ]
  },
  "SearchOperatorIsNotNullT": {
    "allOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorNumericNullableInteger"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorEqualityNullableString"
      }
    ]
  },
  "SearchOperatorIsNull": {
    "allOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorDate"
      }
    ]
  },
  "SearchOperatorIsNullT": {
    "allOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorNumericNullableInteger"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorEqualityNullableString"
      }
    ]
  },
  "SearchOperatorIsTrue": {
    "allOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorBoolean"
      }
    ]
  },
  "SearchOperatorLessThan": {
    "properties": {
      "value": {}
    },
    "required": [
      "value"
    ]
  },
  "SearchOperatorNumericNullableInteger": {
    "discriminator": {
      "mapping": {
        "greaterThan": "#/components/schemas/SearchOperatorGreaterThan",
        "is": "#/components/schemas/SearchOperatorIs",
        "isNot": "#/components/schemas/SearchOperatorIsNot",
        "isNotNull": "#/components/schemas/SearchOperatorIsNotNullT",
        "isNull": "#/components/schemas/SearchOperatorIsNullT",
        "lessThan": "#/components/schemas/SearchOperatorLessThan"
      },
      "propertyName": "operator"
    },
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorGreaterThan"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorLessThan"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNullT"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNotNullT"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIs"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNot"
      }
    ],
    "properties": {
      "operator": {
        "type": "string"
      }
    },
    "required": [
      "operator"
    ]
  },
  "SearchOperatorNumericTFloat": {
    "discriminator": {
      "mapping": {
        "greaterThan": "#/components/schemas/SearchOperatorGreaterThan",
        "is": "#/components/schemas/SearchOperatorIs",
        "isNot": "#/components/schemas/SearchOperatorIsNot",
        "lessThan": "#/components/schemas/SearchOperatorLessThan"
      },
      "propertyName": "operator"
    },
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorGreaterThan"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorLessThan"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIs"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNot"
      }
    ],
    "properties": {
      "operator": {
        "type": "string"
      }
    },
    "required": [
      "operator"
    ]
  },
  "SearchOperatorString": {
    "discriminator": {
      "mapping": {
        "beginsWith": "#/components/schemas/SearchOperatorBeginsWith",
        "contains": "#/components/schemas/SearchOperatorContains",
        "doesNotBeginWith": "#/components/schemas/SearchOperatorDoesNotBeginWith",
        "doesNotContain": "#/components/schemas/SearchOperatorDoesNotContain",
        "doesNotEndWith": "#/components/schemas/SearchOperatorDoesNotEndWith",
        "endsWith": "#/components/schemas/SearchOperatorEndsWith",
        "is": "#/components/schemas/SearchOperatorIs",
        "isNot": "#/components/schemas/SearchOperatorIsNot"
      },
      "propertyName": "operator"
    },
    "oneOf": [
      {
        "$ref": "komga#/definitions/SearchOperatorBeginsWith"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorDoesNotBeginWith"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorContains"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorDoesNotContain"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorEndsWith"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorDoesNotEndWith"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIs"
      },
      {
        "$ref": "komga#/definitions/SearchOperatorIsNot"
      }
    ],
    "properties": {
      "operator": {
        "type": "string"
      }
    },
    "required": [
      "operator"
    ]
  },
  "SeriesDto": {
    "type": "object",
    "properties": {
      "booksCount": {
        "type": "integer",
        "format": "int32"
      },
      "booksInProgressCount": {
        "type": "integer",
        "format": "int32"
      },
      "booksMetadata": {
        "$ref": "komga#/definitions/BookMetadataAggregationDto"
      },
      "booksReadCount": {
        "type": "integer",
        "format": "int32"
      },
      "booksUnreadCount": {
        "type": "integer",
        "format": "int32"
      },
      "created": {
        "type": "string",
        "format": "date-time"
      },
      "deleted": {
        "type": "boolean"
      },
      "fileLastModified": {
        "type": "string",
        "format": "date-time"
      },
      "id": {
        "type": "string"
      },
      "lastModified": {
        "type": "string",
        "format": "date-time"
      },
      "libraryId": {
        "type": "string"
      },
      "metadata": {
        "$ref": "komga#/definitions/SeriesMetadataDto"
      },
      "name": {
        "type": "string"
      },
      "oneshot": {
        "type": "boolean"
      },
      "url": {
        "type": "string"
      }
    },
    "required": [
      "booksCount",
      "booksInProgressCount",
      "booksMetadata",
      "booksReadCount",
      "booksUnreadCount",
      "created",
      "deleted",
      "fileLastModified",
      "id",
      "lastModified",
      "libraryId",
      "metadata",
      "name",
      "oneshot",
      "url"
    ]
  },
  "SeriesMetadataDto": {
    "type": "object",
    "properties": {
      "ageRating": {
        "type": "integer",
        "format": "int32"
      },
      "ageRatingLock": {
        "type": "boolean"
      },
      "alternateTitles": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/AlternateTitleDto"
        }
      },
      "alternateTitlesLock": {
        "type": "boolean"
      },
      "created": {
        "type": "string",
        "format": "date-time"
      },
      "genres": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "genresLock": {
        "type": "boolean"
      },
      "language": {
        "type": "string"
      },
      "languageLock": {
        "type": "boolean"
      },
      "lastModified": {
        "type": "string",
        "format": "date-time"
      },
      "links": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WebLinkDto"
        }
      },
      "linksLock": {
        "type": "boolean"
      },
      "publisher": {
        "type": "string"
      },
      "publisherLock": {
        "type": "boolean"
      },
      "readingDirection": {
        "type": "string"
      },
      "readingDirectionLock": {
        "type": "boolean"
      },
      "sharingLabels": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "sharingLabelsLock": {
        "type": "boolean"
      },
      "status": {
        "type": "string"
      },
      "statusLock": {
        "type": "boolean"
      },
      "summary": {
        "type": "string"
      },
      "summaryLock": {
        "type": "boolean"
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "tagsLock": {
        "type": "boolean"
      },
      "title": {
        "type": "string"
      },
      "titleLock": {
        "type": "boolean"
      },
      "titleSort": {
        "type": "string"
      },
      "titleSortLock": {
        "type": "boolean"
      },
      "totalBookCount": {
        "type": "integer",
        "format": "int32"
      },
      "totalBookCountLock": {
        "type": "boolean"
      }
    },
    "required": [
      "ageRatingLock",
      "alternateTitles",
      "alternateTitlesLock",
      "created",
      "genres",
      "genresLock",
      "language",
      "languageLock",
      "lastModified",
      "links",
      "linksLock",
      "publisher",
      "publisherLock",
      "readingDirection",
      "readingDirectionLock",
      "sharingLabels",
      "sharingLabelsLock",
      "status",
      "statusLock",
      "summary",
      "summaryLock",
      "tags",
      "tagsLock",
      "title",
      "titleLock",
      "titleSort",
      "titleSortLock",
      "totalBookCountLock"
    ]
  },
  "SeriesMetadataUpdateDto": {
    "type": "object",
    "description": "Metadata fields to update. Set a field to null to unset the metadata. You can omit fields you don't want to update.",
    "properties": {
      "ageRating": {
        "type": "integer",
        "format": "int32"
      },
      "ageRatingLock": {
        "type": "boolean"
      },
      "alternateTitles": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/AlternateTitleUpdateDto"
        }
      },
      "alternateTitlesLock": {
        "type": "boolean"
      },
      "genres": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "genresLock": {
        "type": "boolean"
      },
      "language": {
        "type": "string"
      },
      "languageLock": {
        "type": "boolean"
      },
      "links": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WebLinkUpdateDto"
        }
      },
      "linksLock": {
        "type": "boolean"
      },
      "publisher": {
        "type": "string"
      },
      "publisherLock": {
        "type": "boolean"
      },
      "readingDirection": {
        "type": "string",
        "enum": [
          "LEFT_TO_RIGHT",
          "RIGHT_TO_LEFT",
          "VERTICAL",
          "WEBTOON"
        ]
      },
      "readingDirectionLock": {
        "type": "boolean"
      },
      "sharingLabels": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "sharingLabelsLock": {
        "type": "boolean"
      },
      "status": {
        "type": "string",
        "enum": [
          "ENDED",
          "ONGOING",
          "ABANDONED",
          "HIATUS"
        ]
      },
      "statusLock": {
        "type": "boolean"
      },
      "summary": {
        "type": "string"
      },
      "summaryLock": {
        "type": "boolean"
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "tagsLock": {
        "type": "boolean"
      },
      "title": {
        "type": "string"
      },
      "titleLock": {
        "type": "boolean"
      },
      "titleSort": {
        "type": "string"
      },
      "titleSortLock": {
        "type": "boolean"
      },
      "totalBookCount": {
        "type": "integer",
        "format": "int32"
      },
      "totalBookCountLock": {
        "type": "boolean"
      }
    }
  },
  "SeriesSearch": {
    "type": "object",
    "properties": {
      "condition": {
        "$ref": "komga#/definitions/SearchConditionSeries"
      },
      "fullTextSearch": {
        "type": "string"
      }
    }
  },
  "SettingMultiSourceInteger": {
    "type": "object",
    "properties": {
      "configurationSource": {
        "type": "integer",
        "format": "int32"
      },
      "databaseSource": {
        "type": "integer",
        "format": "int32"
      },
      "effectiveValue": {
        "type": "integer",
        "format": "int32"
      }
    }
  },
  "SettingMultiSourceString": {
    "type": "object",
    "properties": {
      "configurationSource": {
        "type": "string"
      },
      "databaseSource": {
        "type": "string"
      },
      "effectiveValue": {
        "type": "string"
      }
    }
  },
  "SettingsDto": {
    "type": "object",
    "properties": {
      "deleteEmptyCollections": {
        "type": "boolean"
      },
      "deleteEmptyReadLists": {
        "type": "boolean"
      },
      "kepubifyPath": {
        "$ref": "komga#/definitions/SettingMultiSourceString"
      },
      "koboPort": {
        "type": "integer",
        "format": "int32"
      },
      "koboProxy": {
        "type": "boolean"
      },
      "maxUploadFileSizeBytes": {
        "type": "integer",
        "format": "int64"
      },
      "rememberMeDurationDays": {
        "type": "integer",
        "format": "int64"
      },
      "serverContextPath": {
        "$ref": "komga#/definitions/SettingMultiSourceString"
      },
      "serverPort": {
        "$ref": "komga#/definitions/SettingMultiSourceInteger"
      },
      "taskPoolSize": {
        "type": "integer",
        "format": "int32"
      },
      "thumbnailSize": {
        "type": "string",
        "enum": [
          "DEFAULT",
          "MEDIUM",
          "LARGE",
          "XLARGE"
        ]
      }
    }
  },
  "SettingsUpdateDto": {
    "type": "object",
    "description": "Fields to update. You can omit fields you don't want to update.",
    "properties": {
      "deleteEmptyCollections": {
        "type": "boolean"
      },
      "deleteEmptyReadLists": {
        "type": "boolean"
      },
      "kepubifyPath": {
        "type": "string",
        "deprecated": true,
        "description": "Will be removed in a future version"
      },
      "koboPort": {
        "type": "integer",
        "format": "int32",
        "maximum": 65535
      },
      "koboProxy": {
        "type": "boolean"
      },
      "rememberMeDurationDays": {
        "type": "integer",
        "format": "int64"
      },
      "renewRememberMeKey": {
        "type": "boolean"
      },
      "serverContextPath": {
        "type": "string",
        "pattern": "^/[\\w-/]*[a-zA-Z0-9]$"
      },
      "serverPort": {
        "type": "integer",
        "format": "int32",
        "maximum": 65535
      },
      "taskPoolSize": {
        "type": "integer",
        "format": "int32"
      },
      "thumbnailSize": {
        "type": "string",
        "enum": [
          "DEFAULT",
          "MEDIUM",
          "LARGE",
          "XLARGE"
        ]
      }
    }
  },
  "SharedLibrariesUpdateDto": {
    "type": "object",
    "properties": {
      "all": {
        "type": "boolean"
      },
      "libraryIds": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      }
    },
    "required": [
      "all",
      "libraryIds"
    ]
  },
  "SortObject": {
    "type": "object",
    "properties": {
      "empty": {
        "type": "boolean"
      },
      "sorted": {
        "type": "boolean"
      },
      "unsorted": {
        "type": "boolean"
      }
    }
  },
  "StreamingResponseBody": {},
  "TachiyomiReadProgressDto": {
    "type": "object",
    "properties": {
      "booksCount": {
        "type": "integer",
        "format": "int32"
      },
      "booksInProgressCount": {
        "type": "integer",
        "format": "int32"
      },
      "booksReadCount": {
        "type": "integer",
        "format": "int32"
      },
      "booksUnreadCount": {
        "type": "integer",
        "format": "int32"
      },
      "lastReadContinuousIndex": {
        "type": "integer",
        "format": "int32"
      }
    },
    "required": [
      "booksCount",
      "booksInProgressCount",
      "booksReadCount",
      "booksUnreadCount",
      "lastReadContinuousIndex"
    ]
  },
  "TachiyomiReadProgressUpdateDto": {
    "type": "object",
    "properties": {
      "lastBookRead": {
        "type": "integer",
        "format": "int32"
      }
    },
    "required": [
      "lastBookRead"
    ]
  },
  "TachiyomiReadProgressUpdateV2Dto": {
    "type": "object",
    "properties": {
      "lastBookNumberSortRead": {
        "type": "number",
        "format": "float"
      }
    },
    "required": [
      "lastBookNumberSortRead"
    ]
  },
  "TachiyomiReadProgressV2Dto": {
    "type": "object",
    "properties": {
      "booksCount": {
        "type": "integer",
        "format": "int32"
      },
      "booksInProgressCount": {
        "type": "integer",
        "format": "int32"
      },
      "booksReadCount": {
        "type": "integer",
        "format": "int32"
      },
      "booksUnreadCount": {
        "type": "integer",
        "format": "int32"
      },
      "lastReadContinuousNumberSort": {
        "type": "number",
        "format": "float"
      },
      "maxNumberSort": {
        "type": "number",
        "format": "float"
      }
    },
    "required": [
      "booksCount",
      "booksInProgressCount",
      "booksReadCount",
      "booksUnreadCount",
      "lastReadContinuousNumberSort",
      "maxNumberSort"
    ]
  },
  "Text": {
    "type": "object",
    "properties": {
      "after": {
        "type": "string"
      },
      "before": {
        "type": "string"
      },
      "highlight": {
        "type": "string"
      }
    }
  },
  "ThumbnailBookDto": {
    "type": "object",
    "properties": {
      "bookId": {
        "type": "string"
      },
      "fileSize": {
        "type": "integer",
        "format": "int64"
      },
      "height": {
        "type": "integer",
        "format": "int32"
      },
      "id": {
        "type": "string"
      },
      "mediaType": {
        "type": "string"
      },
      "selected": {
        "type": "boolean"
      },
      "type": {
        "type": "string"
      },
      "width": {
        "type": "integer",
        "format": "int32"
      }
    },
    "required": [
      "bookId",
      "fileSize",
      "height",
      "id",
      "mediaType",
      "selected",
      "type",
      "width"
    ]
  },
  "ThumbnailReadListDto": {
    "type": "object",
    "properties": {
      "fileSize": {
        "type": "integer",
        "format": "int64"
      },
      "height": {
        "type": "integer",
        "format": "int32"
      },
      "id": {
        "type": "string"
      },
      "mediaType": {
        "type": "string"
      },
      "readListId": {
        "type": "string"
      },
      "selected": {
        "type": "boolean"
      },
      "type": {
        "type": "string"
      },
      "width": {
        "type": "integer",
        "format": "int32"
      }
    },
    "required": [
      "fileSize",
      "height",
      "id",
      "mediaType",
      "readListId",
      "selected",
      "type",
      "width"
    ]
  },
  "ThumbnailSeriesCollectionDto": {
    "type": "object",
    "properties": {
      "collectionId": {
        "type": "string"
      },
      "fileSize": {
        "type": "integer",
        "format": "int64"
      },
      "height": {
        "type": "integer",
        "format": "int32"
      },
      "id": {
        "type": "string"
      },
      "mediaType": {
        "type": "string"
      },
      "selected": {
        "type": "boolean"
      },
      "type": {
        "type": "string"
      },
      "width": {
        "type": "integer",
        "format": "int32"
      }
    },
    "required": [
      "collectionId",
      "fileSize",
      "height",
      "id",
      "mediaType",
      "selected",
      "type",
      "width"
    ]
  },
  "ThumbnailSeriesDto": {
    "type": "object",
    "properties": {
      "fileSize": {
        "type": "integer",
        "format": "int64"
      },
      "height": {
        "type": "integer",
        "format": "int32"
      },
      "id": {
        "type": "string"
      },
      "mediaType": {
        "type": "string"
      },
      "selected": {
        "type": "boolean"
      },
      "seriesId": {
        "type": "string"
      },
      "type": {
        "type": "string"
      },
      "width": {
        "type": "integer",
        "format": "int32"
      }
    },
    "required": [
      "fileSize",
      "height",
      "id",
      "mediaType",
      "selected",
      "seriesId",
      "type",
      "width"
    ]
  },
  "TransientBookDto": {
    "type": "object",
    "properties": {
      "comment": {
        "type": "string"
      },
      "fileLastModified": {
        "type": "string",
        "format": "date-time"
      },
      "files": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "id": {
        "type": "string"
      },
      "mediaType": {
        "type": "string"
      },
      "name": {
        "type": "string"
      },
      "number": {
        "type": "number",
        "format": "float"
      },
      "pages": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/PageDto"
        }
      },
      "seriesId": {
        "type": "string"
      },
      "size": {
        "type": "string"
      },
      "sizeBytes": {
        "type": "integer",
        "format": "int64"
      },
      "status": {
        "type": "string"
      },
      "url": {
        "type": "string"
      }
    },
    "required": [
      "comment",
      "fileLastModified",
      "files",
      "id",
      "mediaType",
      "name",
      "pages",
      "size",
      "sizeBytes",
      "status",
      "url"
    ]
  },
  "UserCreationDto": {
    "type": "object",
    "properties": {
      "ageRestriction": {
        "$ref": "komga#/definitions/AgeRestrictionUpdateDto"
      },
      "email": {
        "type": "string"
      },
      "labelsAllow": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "labelsExclude": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "password": {
        "type": "string",
        "minLength": 1
      },
      "roles": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "sharedLibraries": {
        "$ref": "komga#/definitions/SharedLibrariesUpdateDto"
      }
    },
    "required": [
      "email",
      "password",
      "roles"
    ]
  },
  "UserDto": {
    "type": "object",
    "properties": {
      "ageRestriction": {
        "$ref": "komga#/definitions/AgeRestrictionDto"
      },
      "email": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "labelsAllow": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "labelsExclude": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "roles": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "sharedAllLibraries": {
        "type": "boolean"
      },
      "sharedLibrariesIds": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      }
    },
    "required": [
      "email",
      "id",
      "labelsAllow",
      "labelsExclude",
      "roles",
      "sharedAllLibraries",
      "sharedLibrariesIds"
    ]
  },
  "UserUpdateDto": {
    "type": "object",
    "properties": {
      "ageRestriction": {
        "$ref": "komga#/definitions/AgeRestrictionUpdateDto"
      },
      "labelsAllow": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "labelsExclude": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "roles": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true
      },
      "sharedLibraries": {
        "$ref": "komga#/definitions/SharedLibrariesUpdateDto"
      }
    }
  },
  "ValidationErrorResponse": {
    "type": "object",
    "properties": {
      "violations": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/Violation"
        }
      }
    },
    "required": [
      "violations"
    ]
  },
  "Violation": {
    "type": "object",
    "properties": {
      "fieldName": {
        "type": "string"
      },
      "message": {
        "type": "string"
      }
    }
  },
  "WPBelongsToDto": {
    "type": "object",
    "properties": {
      "collection": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WPContributorDto"
        }
      },
      "series": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WPContributorDto"
        }
      }
    },
    "required": [
      "collection",
      "series"
    ]
  },
  "WPContributorDto": {
    "type": "object",
    "properties": {
      "links": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WPLinkDto"
        }
      },
      "name": {
        "type": "string"
      },
      "position": {
        "type": "number",
        "format": "float"
      }
    },
    "required": [
      "links",
      "name"
    ]
  },
  "WPLinkDto": {
    "type": "object",
    "properties": {
      "height": {
        "type": "integer",
        "format": "int32"
      },
      "href": {
        "type": "string"
      },
      "properties": {
        "type": "object",
        "additionalProperties": {
          "type": "object",
          "additionalProperties": {}
        }
      },
      "rel": {
        "type": "string"
      },
      "templated": {
        "type": "boolean"
      },
      "title": {
        "type": "string"
      },
      "type": {
        "type": "string"
      },
      "width": {
        "type": "integer",
        "format": "int32"
      }
    },
    "required": [
      "properties"
    ]
  },
  "WPMetadataDto": {
    "type": "object",
    "properties": {
      "artist": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "author": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "belongsTo": {
        "$ref": "komga#/definitions/WPBelongsToDto"
      },
      "colorist": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "conformsTo": {
        "type": "string"
      },
      "contributor": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "description": {
        "type": "string"
      },
      "editor": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "identifier": {
        "type": "string"
      },
      "illustrator": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "inker": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "language": {
        "type": "string"
      },
      "letterer": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "modified": {
        "type": "string",
        "format": "date-time"
      },
      "numberOfPages": {
        "type": "integer",
        "format": "int32"
      },
      "penciler": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "published": {
        "type": "string",
        "format": "date"
      },
      "publisher": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "readingProgression": {
        "type": "string",
        "enum": [
          "rtl",
          "ltr",
          "ttb",
          "btt",
          "auto"
        ]
      },
      "rendition": {
        "type": "object",
        "additionalProperties": {}
      },
      "sortAs": {
        "type": "string"
      },
      "subject": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "subtitle": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "translator": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "type": {
        "type": "string"
      }
    },
    "required": [
      "artist",
      "author",
      "colorist",
      "contributor",
      "editor",
      "illustrator",
      "inker",
      "letterer",
      "penciler",
      "publisher",
      "rendition",
      "subject",
      "title",
      "translator"
    ]
  },
  "WPPublicationDto": {
    "type": "object",
    "properties": {
      "context": {
        "type": "string"
      },
      "images": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WPLinkDto"
        }
      },
      "landmarks": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WPLinkDto"
        }
      },
      "links": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WPLinkDto"
        }
      },
      "metadata": {
        "$ref": "komga#/definitions/WPMetadataDto"
      },
      "pageList": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WPLinkDto"
        }
      },
      "readingOrder": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WPLinkDto"
        }
      },
      "resources": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WPLinkDto"
        }
      },
      "toc": {
        "type": "array",
        "items": {
          "$ref": "komga#/definitions/WPLinkDto"
        }
      }
    },
    "required": [
      "images",
      "landmarks",
      "links",
      "metadata",
      "pageList",
      "readingOrder",
      "resources",
      "toc"
    ]
  },
  "WebLinkDto": {
    "type": "object",
    "properties": {
      "label": {
        "type": "string"
      },
      "url": {
        "type": "string"
      }
    },
    "required": [
      "label",
      "url"
    ]
  },
  "WebLinkUpdateDto": {
    "type": "object",
    "properties": {
      "label": {
        "type": "string",
        "minLength": 1
      },
      "url": {
        "type": "string"
      }
    },
    "required": [
      "label"
    ]
  }
}

export const routes: GeneratedRoute[] = [
  {
    "method": "GET",
    "url": "/api/v1/libraries",
    "operationId": "getLibraries",
    "schema": {
      "response": {
        "200": {
          "type": "array",
          "items": {
            "$ref": "komga#/definitions/LibraryDto"
          }
        }
      }
    }
  },
  {
    "method": "POST",
    "url": "/api/v1/libraries",
    "operationId": "addLibrary",
    "schema": {
      "body": {
        "$ref": "komga#/definitions/LibraryCreationDto"
      },
      "response": {
        "200": {
          "$ref": "komga#/definitions/LibraryDto"
        }
      }
    }
  },
  {
    "method": "GET",
    "url": "/api/v1/libraries/:libraryId",
    "operationId": "getLibraryById",
    "schema": {
      "params": {
        "type": "object",
        "properties": {
          "libraryId": {
            "type": "string"
          }
        },
        "required": [
          "libraryId"
        ]
      },
      "response": {
        "200": {
          "$ref": "komga#/definitions/LibraryDto"
        }
      }
    }
  },
  {
    "method": "PUT",
    "url": "/api/v1/libraries/:libraryId",
    "operationId": "updateLibraryByIdDeprecated",
    "schema": {
      "params": {
        "type": "object",
        "properties": {
          "libraryId": {
            "type": "string"
          }
        },
        "required": [
          "libraryId"
        ]
      },
      "body": {
        "$ref": "komga#/definitions/LibraryUpdateDto"
      }
    }
  },
  {
    "method": "PATCH",
    "url": "/api/v1/libraries/:libraryId",
    "operationId": "updateLibraryById",
    "schema": {
      "params": {
        "type": "object",
        "properties": {
          "libraryId": {
            "type": "string"
          }
        },
        "required": [
          "libraryId"
        ]
      },
      "body": {
        "$ref": "komga#/definitions/LibraryUpdateDto"
      }
    }
  },
  {
    "method": "DELETE",
    "url": "/api/v1/libraries/:libraryId",
    "operationId": "deleteLibraryById",
    "schema": {
      "params": {
        "type": "object",
        "properties": {
          "libraryId": {
            "type": "string"
          }
        },
        "required": [
          "libraryId"
        ]
      }
    }
  },
  {
    "method": "POST",
    "url": "/api/v1/libraries/:libraryId/analyze",
    "operationId": "libraryAnalyze",
    "schema": {
      "params": {
        "type": "object",
        "properties": {
          "libraryId": {
            "type": "string"
          }
        },
        "required": [
          "libraryId"
        ]
      }
    }
  },
  {
    "method": "POST",
    "url": "/api/v1/libraries/:libraryId/empty-trash",
    "operationId": "libraryEmptyTrash",
    "schema": {
      "params": {
        "type": "object",
        "properties": {
          "libraryId": {
            "type": "string"
          }
        },
        "required": [
          "libraryId"
        ]
      }
    }
  },
  {
    "method": "POST",
    "url": "/api/v1/libraries/:libraryId/metadata/refresh",
    "operationId": "libraryRefreshMetadata",
    "schema": {
      "params": {
        "type": "object",
        "properties": {
          "libraryId": {
            "type": "string"
          }
        },
        "required": [
          "libraryId"
        ]
      }
    }
  },
  {
    "method": "POST",
    "url": "/api/v1/libraries/:libraryId/scan",
    "operationId": "libraryScan",
    "schema": {
      "params": {
        "type": "object",
        "properties": {
          "libraryId": {
            "type": "string"
          }
        },
        "required": [
          "libraryId"
        ]
      },
      "querystring": {
        "type": "object",
        "properties": {
          "deep": {
            "type": "boolean"
          }
        }
      }
    }
  }
]

/** Register the shared component schemas so `$ref: "komga#/definitions/..."` resolves. */
export function registerSchemas(app: FastifyInstance): void {
  app.addSchema({ $id: 'komga', definitions } as never)
}
