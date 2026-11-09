"use client";
/**
 * Receipts ledger: every purchase attempt in AG Grid (Community).
 * Rows come from GET /api/purchases and are updated live from SSE via applyTransaction.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
  type GetRowIdParams,
  type RowClassParams,
} from "ag-grid-community";
import type { Mandate, Purchase } from "./types";
import { clock, money } from "./api";
import { RulePill, StatusChip } from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: "var(--font-public-sans), system-ui, sans-serif",
  headerFontFamily: "var(--font-public-sans), system-ui, sans-serif",
  fontSize: 13.5,
  headerFontSize: 12.5,
  headerFontWeight: 600,
  foregroundColor: "#0c1b33",
  textColor: "#0c1b33",
  headerTextColor: "#66738a",
  headerBackgroundColor: "#f6f8fa",
  backgroundColor: "#ffffff",
  borderColor: "#dde2ea",
  rowBorder: { color: "#eaedf2" },
  columnBorder: false,
  headerColumnBorder: false,
  wrapperBorderRadius: 16,
  accentColor: "#1f4fd6",
  rowHoverColor: "#f6f8fa",
  selectedRowBackgroundColor: "#ebeffd",
  iconSize: 14,
  spacing: 7,
  rowHeight: 46,
  headerHeight: 40,
});

export type LedgerHandle = { upsert: (p: Purchase) => void; setRows: (rows: Purchase[]) => void };

const StatusCell = (p: ICellRendererParams<Purchase>) => (p.value ? <StatusChip status={p.value} /> : null);

const FailedCell = (p: ICellRendererParams<Purchase>) => {
  const rules = p.data?.failedRules ?? [];
  if (!rules.length) return <span className="text-[13px] text-paid">All {p.data?.ruleResults.length ?? 10} passed</span>;
  return (
    <div className="flex flex-wrap items-center gap-1 py-1.5 leading-none">
      {rules.map((r) => (
        <RulePill key={r.rule} rule={r.rule} kind={r.kind} />
      ))}
    </div>
  );
};

const PayPalCell = (p: ICellRendererParams<Purchase>) => {
  const pp = p.data?.paypal;
  if (!pp) return null;
  if (!pp.called) return <span className="text-[13px] font-medium text-blocked">Never called</span>;
  const id = pp.refundId ? `refund ${pp.refundId}` : pp.captureId ? `capture ${pp.captureId}` : pp.authorizationId ? `auth ${pp.authorizationId}` : pp.orderId ? `order ${pp.orderId}` : "called";
  return <span className="font-mono text-[12px] text-ink-2">{id}</span>;
};

const ActorCell = (p: ICellRendererParams<Purchase>) => {
  const a: string = p.value ?? "";
  const label = a === "agent:allowance" ? "Allowance agent" : a === "agent:redteam" ? "Red-team agent" : a.startsWith("mcp:") ? `MCP client ${a.slice(4)}` : a.startsWith("user:") ? `You (${a.slice(5)})` : a;
  return <span className="text-[13px] text-ink-2">{label}</span>;
};

export const Ledger = forwardRef<LedgerHandle, { rows: Purchase[]; mandates: Mandate[]; onOpen: (p: Purchase) => void; quickFilter: string }>(
  function Ledger({ rows, mandates, onOpen, quickFilter }, ref) {
    const grid = useRef<AgGridReact<Purchase>>(null);
    // Rows are seeded once; after that they change only through applyTransaction (live SSE upserts).
    const [initialRows] = useState(rows);
    const titles = useMemo(() => Object.fromEntries(mandates.map((m) => [m.id, m.title])), [mandates]);

    useImperativeHandle(ref, () => ({
      upsert(p) {
        const api = grid.current?.api;
        if (!api) return;
        if (api.getRowNode(p.id)) api.applyTransaction({ update: [p] });
        else api.applyTransaction({ add: [p], addIndex: 0 });
        api.flashCells({ rowNodes: [api.getRowNode(p.id)!].filter(Boolean) });
      },
      setRows(r) {
        grid.current?.api?.setGridOption("rowData", r);
      },
    }));

    const cols = useMemo<ColDef<Purchase>[]>(
      () => [
        { headerName: "Time", field: "createdAt", width: 96, sort: "desc", valueFormatter: (p) => (p.value ? clock(p.value) : ""), filter: false },
        { headerName: "Status", field: "status", width: 118, cellRenderer: StatusCell, filter: "agTextColumnFilter" },
        {
          headerName: "Attempt",
          valueGetter: (p) => (p.data ? `${p.data.quantity} × ${p.data.product.name}` : ""),
          flex: 1.4,
          minWidth: 200,
          cellClass: "font-medium",
        },
        { headerName: "Category", valueGetter: (p) => p.data?.product.category, width: 120, valueFormatter: (p) => (p.value ? String(p.value).replace(/_/g, " ") : ""), cellClass: "text-ink-2 capitalize" },
        {
          headerName: "Amount",
          valueGetter: (p) => p.data?.total.amountCents,
          valueFormatter: (p) => (p.value != null ? money(p.value) : ""),
          width: 110,
          type: "rightAligned",
          filter: "agNumberColumnFilter",
          cellClass: "num font-semibold",
        },
        { headerName: "Mandate", valueGetter: (p) => (p.data ? (titles[p.data.mandateId] ?? p.data.mandateId) : ""), flex: 1, minWidth: 150 },
        { headerName: "Requested by", field: "requestedBy", width: 140, cellRenderer: ActorCell },
        {
          headerName: "Failed rules",
          valueGetter: (p) => p.data?.failedRules.map((r) => r.rule).join(" "),
          cellRenderer: FailedCell,
          flex: 1.3,
          minWidth: 200,
          autoHeight: true,
          wrapText: true,
        },
        { headerName: "PayPal", valueGetter: (p) => p.data?.paypal.captureId ?? p.data?.paypal.authorizationId ?? "", cellRenderer: PayPalCell, width: 190 },
      ],
      [titles],
    );

    return (
      <div className="h-full min-h-[320px]">
        <AgGridReact<Purchase>
          ref={grid}
          theme={theme}
          rowData={initialRows}
          columnDefs={cols}
          defaultColDef={{ sortable: true, resizable: true, filter: true, enableCellChangeFlash: true }}
          getRowId={(p: GetRowIdParams<Purchase>) => p.data.id}
          onRowClicked={(e) => e.data && onOpen(e.data)}
          rowClass="cursor-pointer"
          getRowStyle={(p: RowClassParams<Purchase>) => (p.data?.status === "BLOCKED" ? { background: "#fffafa" } : undefined)}
          quickFilterText={quickFilter}
          animateRows
          overlayNoRowsTemplate="<span style='color:#66738a;font-size:14px'>No purchase attempts yet. Create a mandate and run the agent.</span>"
        />
      </div>
    );
  },
);
