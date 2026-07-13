package mcpserver

import (
	"context"
	"fmt"
	"strings"

	"boardripper/boarddb"
	"boardripper/databank"
	"boardripper/obd"
	"boardripper/pdfindex"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// MaxDownloadBytes caps file_download so the model doesn't get handed
// multi-hundred-MB files; larger files should be paged via pdf_page_image/text.
// Exported so main.go's FileBytes wiring can pre-check against the same cap.
const MaxDownloadBytes = 50 << 20 // 50 MiB

// MimeForExt maps a file extension (with or without leading dot) to a MIME
// type for file_download's content block. Exported so main.go's FileBytes
// wiring can reuse the same mapping.
func MimeForExt(ext string) string {
	switch strings.ToLower(strings.TrimPrefix(ext, ".")) {
	case "pdf":
		return "application/pdf"
	case "png":
		return "image/png"
	case "jpg", "jpeg":
		return "image/jpeg"
	default:
		return "application/octet-stream"
	}
}

// binaryResult wraps binary tool output: an ImageContent block for image/*
// MIME types, otherwise an EmbeddedResource blob, plus the metadata map as
// StructuredContent so the model gets both the bytes and the dimensions/size.
func binaryResult(mime string, data []byte, meta map[string]any) *mcp.CallToolResult {
	var content mcp.Content
	if strings.HasPrefix(mime, "image/") {
		content = &mcp.ImageContent{Data: data, MIMEType: mime}
	} else {
		content = &mcp.EmbeddedResource{Resource: &mcp.ResourceContents{
			URI: "boardripper://download", MIMEType: mime, Blob: data,
		}}
	}
	return &mcp.CallToolResult{
		Content:           []mcp.Content{content},
		StructuredContent: meta,
	}
}

// --- store interfaces (satisfied by the concrete backend types) ---

// PDFSearcher is satisfied by *pdfindex.DB.
type PDFSearcher interface {
	SearchPages(query string, restrictTo []int64, limit int) ([]pdfindex.SearchHit, error)
}

// FileStore is satisfied by *databank.DB.
type FileStore interface {
	ListFiles(ctx context.Context, fileType, manufacturer string, donorOnly bool) ([]databank.FileRecord, error)
	GetFileByID(ctx context.Context, id int64) (*databank.FileRecord, error)
	GetBindingsForFile(ctx context.Context, fileID int64) ([]databank.BindingDetail, error)
	GetConfig(key string) (string, error)
}

// BoardResolver is satisfied by *boarddb.DB.
type BoardResolver interface {
	Resolve(boardNumber string) *boarddb.BoardMatch
}

// ObdStore is satisfied by *obd.Store.
type ObdStore interface {
	ReadIndex() (*obd.Index, error)
	ReadParsed(bpath string) (*obd.ObdData, error)
	IsFetched(bpath string) (bool, *string)
}

func ro(b bool) *mcp.ToolAnnotations { return &mcp.ToolAnnotations{ReadOnlyHint: b} }

// --- pdf_search ---

type pdfSearchArgs struct {
	Query  string `json:"query" jsonschema:"full-text query (part numbers, designators, keywords)"`
	Limit  int    `json:"limit,omitempty" jsonschema:"max hits (default 200, cap 1000)"`
	FileID int64  `json:"file_id,omitempty" jsonschema:"optional: restrict search to a single indexed file id"`
}
type pdfHit struct {
	FileID  int64  `json:"file_id"`
	PageNum int    `json:"page_num"`
	Snippet string `json:"snippet"`
}
type pdfSearchResult struct {
	Hits  []pdfHit `json:"hits"`
	Total int      `json:"total"`
}

// --- obd ---

type obdMatchArgs struct {
	BoardNumber string `json:"board_number" jsonschema:"board number to match against the OBD index"`
}
type obdMatchEntry struct {
	Bpath    string `json:"bpath"`
	Brand    string `json:"brand"`
	Category string `json:"category"`
	Fetched  bool   `json:"fetched"`
}
type obdMatchResult struct {
	Matches []obdMatchEntry `json:"matches"`
	Synced  bool            `json:"index_synced"`
}
type obdDataArgs struct {
	Bpath string `json:"bpath" jsonschema:"the bpath returned by obd_match"`
}

// --- board_resolve ---

type boardResolveArgs struct {
	BoardNumber string `json:"board_number" jsonschema:"board number to resolve (e.g. 820-02016, LA-K371P)"`
}

// --- file_list / file_get ---

type fileListArgs struct {
	FileType     string `json:"file_type,omitempty" jsonschema:"filter: board | pdf | other"`
	Manufacturer string `json:"manufacturer,omitempty"`
	DonorOnly    bool   `json:"donor_only,omitempty"`
}
type fileListResult struct {
	Files []databank.FileRecord `json:"files"`
	Total int                   `json:"total"`
}
type fileGetArgs struct {
	ID int64 `json:"id"`
}
type fileGetResult struct {
	File     *databank.FileRecord     `json:"file"`
	Bindings []databank.BindingDetail `json:"bindings"`
}

func registerNativeTools(s *mcp.Server, deps *Deps) {
	if deps.PDF != nil {
		mcp.AddTool(s, &mcp.Tool{
			Name:        "pdf_search",
			Description: "Full-text search across the indexed PDF library (library-wide); pass file_id to scope to one document. Returns file_id, page, and a snippet for each hit.",
			Annotations: ro(true),
		}, func(ctx context.Context, _ *mcp.CallToolRequest, a pdfSearchArgs) (*mcp.CallToolResult, pdfSearchResult, error) {
			limit := a.Limit
			if limit <= 0 || limit > 1000 {
				limit = 200
			}
			var restrict []int64
			if a.FileID > 0 {
				restrict = []int64{a.FileID}
			}
			hits, err := deps.PDF.SearchPages(a.Query, restrict, limit)
			if err != nil {
				return errResult("pdf search failed: " + err.Error()), pdfSearchResult{}, nil
			}
			out := make([]pdfHit, 0, len(hits))
			for _, h := range hits {
				out = append(out, pdfHit{FileID: h.FileID, PageNum: h.PageNum, Snippet: h.Snippet})
			}
			return nil, pdfSearchResult{Hits: out, Total: len(out)}, nil
		})
	}

	if deps.OBD != nil {
		mcp.AddTool(s, &mcp.Tool{
			Name:        "obd_match",
			Description: "Match a board number against the cached OpenBoardData index. Returns candidate bpaths to pass to obd_data.",
			Annotations: ro(true),
		}, func(ctx context.Context, _ *mcp.CallToolRequest, a obdMatchArgs) (*mcp.CallToolResult, obdMatchResult, error) {
			idx, err := deps.OBD.ReadIndex()
			if err != nil || idx == nil {
				return nil, obdMatchResult{Matches: []obdMatchEntry{}, Synced: false}, nil
			}
			bn := normalizeForMatch(a.BoardNumber)
			res := obdMatchResult{Matches: []obdMatchEntry{}, Synced: true}
			if bn == "" {
				return nil, res, nil
			}
			for _, e := range idx.Boards {
				leaf := e.Bpath
				if i := strings.LastIndex(leaf, "/"); i >= 0 {
					leaf = leaf[i+1:]
				}
				if !strings.Contains(normalizeForMatch(leaf), bn) {
					continue
				}
				fetched, _ := deps.OBD.IsFetched(e.Bpath)
				res.Matches = append(res.Matches, obdMatchEntry{
					Bpath: e.Bpath, Brand: e.Brand, Category: e.Category, Fetched: fetched,
				})
			}
			return nil, res, nil
		})

		mcp.AddTool(s, &mcp.Tool{
			Name:        "obd_data",
			Description: "Fetch cached OpenBoardData diagnostics for a bpath: nets with diode/voltage/resistance readings plus diagnosis sections. Returns an error if not yet fetched.",
			Annotations: ro(true),
		}, func(ctx context.Context, _ *mcp.CallToolRequest, a obdDataArgs) (*mcp.CallToolResult, *obd.ObdData, error) {
			data, err := deps.OBD.ReadParsed(a.Bpath)
			if err != nil {
				return errResult("obd data unavailable (fetch it first via the OBD panel): " + err.Error()), nil, nil
			}
			return nil, data, nil
		})
	}

	if deps.Boards != nil {
		mcp.AddTool(s, &mcp.Tool{
			Name:        "board_resolve",
			Description: "Resolve a board number to brand/family/model/color/ODM/aliases from the reference database.",
			Annotations: ro(true),
		}, func(ctx context.Context, _ *mcp.CallToolRequest, a boardResolveArgs) (*mcp.CallToolResult, *boarddb.BoardMatch, error) {
			m := deps.Boards.Resolve(a.BoardNumber)
			if m == nil {
				return errResult("no reference match for " + a.BoardNumber), nil, nil
			}
			return nil, m, nil
		})
	}

	if deps.Files != nil {
		mcp.AddTool(s, &mcp.Tool{
			Name:        "file_list",
			Description: "List indexed board/PDF files with optional type/manufacturer/donor filters.",
			Annotations: ro(true),
		}, func(ctx context.Context, _ *mcp.CallToolRequest, a fileListArgs) (*mcp.CallToolResult, fileListResult, error) {
			recs, err := deps.Files.ListFiles(ctx, a.FileType, a.Manufacturer, a.DonorOnly)
			if err != nil {
				return errResult("file list failed: " + err.Error()), fileListResult{}, nil
			}
			return nil, fileListResult{Files: recs, Total: len(recs)}, nil
		})

		mcp.AddTool(s, &mcp.Tool{
			Name:        "file_get",
			Description: "Get one file's metadata plus its board/PDF bindings.",
			Annotations: ro(true),
		}, func(ctx context.Context, _ *mcp.CallToolRequest, a fileGetArgs) (*mcp.CallToolResult, fileGetResult, error) {
			rec, err := deps.Files.GetFileByID(ctx, a.ID)
			if err != nil {
				return errResult("file not found: " + err.Error()), fileGetResult{}, nil
			}
			bindings, _ := deps.Files.GetBindingsForFile(ctx, a.ID)
			return nil, fileGetResult{File: rec, Bindings: bindings}, nil
		})
	}

	if deps.FileBytes != nil {
		mcp.AddTool(s, &mcp.Tool{
			Name:        "file_download",
			Description: "Download a library file by id (from file_list/file_get or a pdf_search hit) as bytes — intended for PDFs/documents the model can read natively. Do NOT download boardview files (BRD/FZ/XZZ/BDV-ASC and most binary board formats): they are encrypted or obfuscated, so the bytes are unreadable — use the live board tools (list_parts/net_info/part_info/etc.) for board data instead. Capped at 50 MiB.",
			Annotations: ro(true),
		}, func(ctx context.Context, _ *mcp.CallToolRequest, a fileGetArgs) (*mcp.CallToolResult, any, error) {
			data, name, mime, err := deps.FileBytes(ctx, a.ID)
			if err != nil {
				return errResult("file_download failed: " + err.Error()), nil, nil
			}
			if len(data) > MaxDownloadBytes {
				return errResult(fmt.Sprintf("file too large (%d bytes, cap %d) — use pdf_page_image/pdf_page_text instead", len(data), MaxDownloadBytes)), nil, nil
			}
			return binaryResult(mime, data, map[string]any{"filename": name, "mime": mime, "size": len(data)}), nil, nil
		})
	}
}

// --- kb_search ---

type kbSearchArgs struct {
	Query string   `json:"query" jsonschema:"what to look up (technique, symptom, concept)"`
	Tags  []string `json:"tags,omitempty" jsonschema:"optional: only chunks carrying ALL these tags"`
	K     int      `json:"k,omitempty" jsonschema:"max chunks to return (default 5, cap 50)"`
}
type kbHit struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Tags    []string `json:"tags"`
	Snippet string   `json:"snippet"`
}
type kbSearchResult struct {
	Hits  []kbHit `json:"hits"`
	Total int     `json:"total"`
}

// registerKBSearch registers the kb_search tool over the given loaded KB
// chunks. No-op when chunks is empty (e.g. loadKB failed) so the tool simply
// isn't advertised rather than erroring on every call.
func registerKBSearch(s *mcp.Server, chunks []kbChunk) {
	if len(chunks) == 0 {
		return
	}
	mcp.AddTool(s, &mcp.Tool{
		Name:        "kb_search",
		Description: "Search the repair knowledge base for relevant technique/concept chunks. Returns top matches (id, title, tags, snippet); read the full chunk via the boardripper://kb/<id> resource.",
		Annotations: ro(true),
	}, func(_ context.Context, _ *mcp.CallToolRequest, a kbSearchArgs) (*mcp.CallToolResult, kbSearchResult, error) {
		found := searchKB(chunks, a.Query, a.Tags, a.K)
		hits := make([]kbHit, 0, len(found))
		for _, c := range found {
			snippet := snippetOf(c.Body, 300)
			hits = append(hits, kbHit{ID: c.ID, Title: c.Title, Tags: c.Tags, Snippet: snippet})
		}
		return nil, kbSearchResult{Hits: hits, Total: len(hits)}, nil
	})
}

// snippetOf returns body truncated to at most max runes (not bytes), with an
// ellipsis when truncated — so a multi-byte rune is never split.
func snippetOf(body string, max int) string {
	r := []rune(body)
	if len(r) <= max {
		return body
	}
	return string(r[:max]) + "…"
}

// normalizeForMatch mirrors handlers.normalizeForMatch so obd_match behaves
// identically to the /api/obd/match endpoint.
func normalizeForMatch(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, "-", "")
	return s
}
