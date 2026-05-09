// Package obd implements OpenBoardData integration: scraping the openboarddata.org
// index, downloading per-board OBDATA_V002 files, parsing them, and caching the
// results on the filesystem under <data_dir>/obd/ (pre-v0.20.3 was rooted at
// <library_root>/.boardripper/openboarddata/; auto-migrated by MigrateLegacyCache).
//
// This package never touches boards.db. OBD is a separate, opt-in data layer
// under ODbL share-alike licensing — see
// docs/superpowers/specs/2026-05-01-openboarddata-integration-design.md.
package obd
