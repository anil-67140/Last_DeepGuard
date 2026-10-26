import React, { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import CytoscapeComponent from 'react-cytoscapejs'
import { graphAPI } from '../utils/api'
import { ChevronLeft, Loader2, ZoomIn, ZoomOut, Maximize2, Info, AlertTriangle, ArrowRightLeft } from 'lucide-react'

const RISK_COLORS = {
  Critical: '#ef4444', High: '#f59e0b', Medium: '#3b82f6',
  Low: '#22c55e', origin: '#38bdf8', circular: '#a855f7'
}

function buildElements(nodes, edges) {
  const cyNodes = nodes.map(n => ({
    data: {
      id: n.id,
      label: n.label?.length > 12 ? n.label.slice(0, 12) + '…' : n.label,
      fullLabel: n.label,
      type: n.type,
      riskScore: n.riskScore,
      riskLevel: n.riskLevel,
      isFraud: n.isFraud,
      bank: n.bank,
      txCount: n.txCount,
      totalAmount: n.totalAmount,
    }
  }))

  // Cytoscape throws a hard, uncaught exception if an edge references a
  // source/target id that isn't in the node set (e.g. a depth-cutoff edge
  // whose far endpoint got excluded) — and that exception happens outside
  // React's render cycle (during react-cytoscapejs's internal cy.add()), so
  // it can silently break the canvas without a React error boundary catching
  // it. Filter these out defensively rather than trusting the backend to
  // never send one.
  const nodeIds = new Set(nodes.map(n => n.id))
  const validEdges = edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))

  const cyEdges = validEdges.slice(0, 500).map((e, i) => ({
    data: {
      id: e.id || `e-${i}`,
      source: e.source,
      target: e.target,
      amount: e.amount,
      format: e.format,
      isFraud: e.isFraud,
      riskScore: e.riskScore,
      fraudCategory: e.fraudCategory,
      timestamp: e.timestamp,
      label: `$${(e.amount || 0).toLocaleString()}`
    }
  }))

  return [...cyNodes, ...cyEdges]
}

/**
 * Force-directed layouts (cose) only know "these two nodes share an edge,
 * pull them together" — they have no concept of "this set of nodes forms a
 * logical cycle, arrange it as a ring." So a genuine A -> B -> C -> A
 * circular-flow cluster can land anywhere the physics simulation settles,
 * and visually look nothing like a circle even though it logically is one.
 *
 * This runs once the base layout has settled, finds connected clusters of
 * "Circular Transaction"-classified edges, and forcibly repositions each
 * cluster's nodes onto an actual geometric circle (keeping the cluster's
 * on-screen location from the base layout, just reshaping it). This makes
 * every real cycle visually read as a circle, every time — not just when
 * the physics happens to cooperate.
 */
function arrangeCircularClusters(cy) {
  const circularEdges = cy.edges().filter(e => e.data('fraudCategory') === 'Circular Transaction');
  if (circularEdges.length === 0) return;

  // Union-find over the endpoints of circular edges to find clusters
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  circularEdges.forEach(e => {
    const s = e.data('source'), t = e.data('target');
    if (!parent.has(s)) parent.set(s, s);
    if (!parent.has(t)) parent.set(t, t);
    union(s, t);
  });

  const clusters = new Map(); // root -> [nodeIds]
  for (const id of parent.keys()) {
    const root = find(id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(id);
  }

  clusters.forEach((nodeIds) => {
    if (nodeIds.length < 2) return;

    // Best-effort walk around the actual cycle so arrows flow consistently
    // around the ring instead of jumping between arbitrary positions.
    const idSet = new Set(nodeIds);
    const adjacency = new Map();
    nodeIds.forEach(id => adjacency.set(id, []));
    circularEdges.forEach(e => {
      const s = e.data('source'), t = e.data('target');
      if (idSet.has(s) && idSet.has(t)) adjacency.get(s).push(t);
    });
    const ordered = [nodeIds[0]];
    const visited = new Set(ordered);
    let current = nodeIds[0];
    while (ordered.length < nodeIds.length) {
      const next = (adjacency.get(current) || []).find(n => !visited.has(n));
      if (!next) break;
      ordered.push(next);
      visited.add(next);
      current = next;
    }
    // Any nodes the walk didn't reach (disconnected sub-branch) — append anyway
    nodeIds.forEach(id => { if (!visited.has(id)) ordered.push(id); });

    // Centroid from the base layout's positions, so the ring lands roughly
    // where the physics simulation already placed this cluster
    const positions = ordered.map(id => cy.getElementById(id).position());
    const cx = positions.reduce((s, p) => s + p.x, 0) / positions.length;
    const cy_ = positions.reduce((s, p) => s + p.y, 0) / positions.length;
    const radius = Math.max(55, ordered.length * 20);

    ordered.forEach((id, i) => {
      const angle = (i / ordered.length) * 2 * Math.PI - Math.PI / 2;
      cy.getElementById(id).position({
        x: cx + radius * Math.cos(angle),
        y: cy_ + radius * Math.sin(angle)
      });
    });
  });
}

// Defense-in-depth: if Cytoscape ever throws during rendering (a malformed
// element, a future edge case we haven't anticipated, etc.), show a clear
// fallback instead of a silently broken/partial canvas.
class GraphErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center max-w-md">
            <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <p className="text-slate-300 text-sm font-medium mb-1">Couldn't render this graph</p>
            <p className="text-slate-500 text-xs">{this.state.error.message}</p>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

const CY_STYLE = [
  {
    selector: 'node',
    style: {
      'background-color': '#334155',
      'border-color': '#475569',
      'border-width': 2,
      'label': 'data(label)',
      'color': '#e2e8f0',
      'font-size': 9,
      'text-valign': 'bottom',
      'text-margin-y': 4,
      'width': 28, 'height': 28,
    }
  },
  {
    selector: 'node[type="origin"]',
    style: { 'background-color': '#0ea5e9', 'border-color': '#38bdf8', 'border-width': 3, 'width': 36, 'height': 36 }
  },
  {
    selector: 'node[?isFraud]',
    style: { 'background-color': '#dc2626', 'border-color': '#ef4444', 'border-width': 2 }
  },
  {
    selector: 'node[riskLevel="Critical"]',
    style: { 'background-color': '#7f1d1d', 'border-color': '#ef4444', 'border-width': 3, 'width': 34, 'height': 34 }
  },
  {
    selector: 'node[type="circular"]',
    style: { 'background-color': '#6b21a8', 'border-color': '#a855f7', 'border-width': 3, 'shape': 'diamond', 'width': 32, 'height': 32 }
  },
  {
    selector: 'node.hovered',
    style: { 'border-color': '#facc15', 'border-width': 5, 'z-index': 999 }
  },
  {
    selector: 'edge',
    style: {
      'width': 1.5,
      'line-color': '#475569',
      'target-arrow-color': '#475569',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      'arrow-scale': 0.8,
    }
  },
  {
    selector: 'edge[?isFraud]',
    style: { 'line-color': '#ef4444', 'target-arrow-color': '#ef4444', 'width': 2.5 }
  },
  {
    selector: 'edge[fraudCategory = "Circular Transaction"]',
    style: { 'line-color': '#a855f7', 'target-arrow-color': '#a855f7', 'width': 3, 'line-style': 'dashed' }
  },
  {
    selector: 'edge.hovered',
    style: { 'width': 5, 'line-color': '#facc15', 'target-arrow-color': '#facc15', 'z-index': 999 }
  },
  {
    selector: ':selected',
    style: { 'border-color': '#38bdf8', 'border-width': 4, 'line-color': '#38bdf8', 'target-arrow-color': '#38bdf8' }
  }
]

export default function GraphPage() {
  const { transactionId } = useParams()
  const [searchParams] = useSearchParams()
  const jobId = searchParams.get('jobId')
  const navigate = useNavigate()
  const cyRef = useRef(null)
  const [graphData, setGraphData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [depth, setDepth] = useState(3)
  const [selected, setSelected] = useState(null) // { kind: 'node'|'edge', data: {...} }
  const [hoverContent, setHoverContent] = useState(null) // just the lines to show — NOT position
  const tooltipRef = useRef(null) // position is updated imperatively via this ref, not via React state,
                                   // so a fast mousemove doesn't force a full component re-render (and,
                                   // in turn, doesn't force react-cytoscapejs's per-render elements-diff
                                   // pass) dozens of times per second while hovering or dragging.
  const [elements, setElements] = useState([])

  useEffect(() => { loadGraph() }, [transactionId, depth])

  const loadGraph = async () => {
    setLoading(true)
    setSelected(null)
    try {
      const res = await graphAPI.getTransactionGraph(transactionId, depth, jobId)
      const data = res.data
      setGraphData(data)
      setElements(buildElements(data.nodes || [], data.edges || []))
    } catch {
      // Demo mode — generate mock graph
      const mockData = generateMockGraph(transactionId)
      setGraphData(mockData)
      setElements(buildElements(mockData.nodes, mockData.edges))
    } finally {
      setLoading(false)
    }
  }

  const handleCyInit = (cy) => {
    // React.StrictMode (used in main.jsx) deliberately mounts, unmounts, then
    // remounts every component once in development to catch missing-cleanup
    // bugs. react-cytoscapejs creates a genuinely NEW Cytoscape core on each
    // mount and destroys the old one on unmount. The only correct guard here
    // is "is this the SAME instance I already bound?" — comparing against
    // cyRef.current. A separate one-time "have I ever bound anything" flag
    // (what an earlier version of this file used) is wrong: it would skip
    // binding listeners and running the layout on the SECOND (real, final)
    // instance StrictMode creates, leaving every node at its default (0,0)
    // position with no click/hover handlers attached at all — which looks
    // exactly like "tiny fragment in a corner, no sidebar, no tooltip."
    if (cyRef.current === cy) return // already bound this exact instance
    cyRef.current = cy

    cy.on('tap', 'node', (evt) => {
      setHoverContent(null)
      setSelected({ kind: 'node', data: evt.target.data() })
    })
    cy.on('tap', 'edge', (evt) => {
      setHoverContent(null)
      setSelected({ kind: 'edge', data: evt.target.data() })
    })
    cy.on('tap', (evt) => {
      if (evt.target === cy) setSelected(null)
    })

    // Hover tooltips — a small floating tooltip that follows the cursor, for
    // both nodes and edges, without needing a click at all. Position is set
    // directly on the DOM node (via tooltipRef) rather than through React
    // state, so mousemove doesn't trigger a React re-render on every pixel —
    // only mouseover/mouseout (which change WHAT is shown) go through state.
    const moveTooltip = (evt) => {
      if (tooltipRef.current) {
        tooltipRef.current.style.left = `${evt.originalEvent.clientX + 14}px`
        tooltipRef.current.style.top = `${evt.originalEvent.clientY + 14}px`
      }
    }

    cy.on('mouseover', 'node', (evt) => {
      const n = evt.target
      n.addClass('hovered')
      const d = n.data()
      const lines = [
        d.fullLabel || d.id,
        `${d.riskLevel || 'Low'} risk · ${(d.riskScore || 0).toFixed(0)}/100`,
        `${d.txCount || 0} tx · $${(d.totalAmount || 0).toLocaleString()}`,
      ]
      if (d.type === 'circular') lines.push('⟲ Part of a circular flow')
      else if (d.isFraud) lines.push('⚠ Flagged as fraud')
      moveTooltip(evt)
      setHoverContent(lines)
    })
    cy.on('mouseout', 'node', (evt) => {
      evt.target.removeClass('hovered')
      setHoverContent(null)
    })
    cy.on('mousemove', 'node', moveTooltip)

    cy.on('mouseover', 'edge', (evt) => {
      const e = evt.target
      e.addClass('hovered')
      const d = e.data()
      const lines = [
        `${d.source} → ${d.target}`,
        `$${(d.amount || 0).toLocaleString()} · ${d.format || 'Unknown'}`,
        `Risk: ${(d.riskScore || 0).toFixed(0)}/100`,
      ]
      if (d.fraudCategory && d.fraudCategory !== 'Clean') lines.push(`⚠ ${d.fraudCategory}`)
      moveTooltip(evt)
      setHoverContent(lines)
    })
    cy.on('mouseout', 'edge', (evt) => {
      evt.target.removeClass('hovered')
      setHoverContent(null)
    })
    cy.on('mousemove', 'edge', moveTooltip)

    const layout = cy.layout({ name: 'cose', animate: true, animationDuration: 800, randomize: false, nodeRepulsion: 4500 })
    layout.one('layoutstop', () => {
      // cose auto-fits the viewport to its OWN final positions when it stops.
      // arrangeCircularClusters() then moves some of those nodes into a
      // perfect circle — which invalidates that fit. Re-fit afterward so the
      // viewport actually frames the graph as it looks now, not as it looked
      // a moment ago. Skipping this was the root cause of the graph looking
      // compressed into a corner / nodes appearing to overlap.
      arrangeCircularClusters(cy)
      cy.fit(undefined, 40)
    })
    layout.run()
  }

  // The sidebar mounting/unmounting changes how much width the flex-1 canvas
  // container actually has, but Cytoscape sizes its internal <canvas> once
  // and doesn't watch for that kind of layout-only resize on its own — tell
  // it to re-measure and re-fit whenever the sidebar's presence changes.
  useEffect(() => {
    if (!cyRef.current) return
    const id = requestAnimationFrame(() => {
      cyRef.current.resize()
    })
    return () => cancelAnimationFrame(id)
  }, [selected?.kind])

  return (
    <div className="flex flex-col h-full bg-slate-900">

      {/* Header */}
      <div className="p-4 border-b border-slate-800 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="font-bold text-white text-sm">Network Graph</h1>
            <p className="text-xs text-slate-400 font-mono">{transactionId}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Depth Selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Depth:</span>
            {[2, 3, 4, 5].map(d => (
              <button key={d} onClick={() => setDepth(d)}
                className={`w-7 h-7 rounded-lg text-xs font-bold transition-colors
                  ${depth === d ? 'bg-sky-500 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                {d}
              </button>
            ))}
          </div>

          {/* Zoom Controls */}
          <div className="flex items-center gap-1">
            <button onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 1.2)}
              className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300">
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 0.8)}
              className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300">
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => cyRef.current?.fit(undefined, 40)}
              className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300">
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Stats Bar */}
      {graphData && (
        <div className="px-4 py-2 border-b border-slate-800 flex items-center gap-5">
          {[
            { label: 'Nodes', value: graphData.nodeCount },
            { label: 'Edges', value: graphData.edgeCount },
            { label: 'Fraud Nodes', value: graphData.riskSummary?.fraudNodes || 0 },
            { label: 'Circular Flows', value: graphData.circularFlowCount || 0 },
            { label: 'Max Risk', value: `${graphData.riskSummary?.maxRisk?.toFixed(0) || 0}/100` },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center gap-2">
              <span className="text-xs text-slate-500">{label}:</span>
              <span className="text-xs font-bold text-white">{value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Graph Canvas + Legend + Node Detail */}
      <div className="flex-1 flex overflow-hidden">

        {/* Cytoscape Canvas */}
        <div className="flex-1 relative min-w-0">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <Loader2 className="w-10 h-10 text-sky-400 animate-spin mx-auto mb-3" />
                <p className="text-slate-400 text-sm">Building network graph…</p>
              </div>
            </div>
          ) : (
            <GraphErrorBoundary>
              <CytoscapeComponent
                elements={elements}
                style={{ width: '100%', height: '100%' }}
                stylesheet={CY_STYLE}
                cy={handleCyInit}
                userZoomingEnabled={true}
                userPanningEnabled={true}
                minZoom={0.1}
                maxZoom={4}
              />
            </GraphErrorBoundary>
          )}

          {/* Hover tooltip — position set imperatively via ref (see moveTooltip),
              content/visibility via React state. Always mounted (display toggled)
              so the ref exists before the first mouseover fires. */}
          <div
            ref={tooltipRef}
            className="fixed z-50 pointer-events-none bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 shadow-xl"
            style={{ maxWidth: 240, display: hoverContent ? 'block' : 'none' }}
          >
            {hoverContent?.map((line, i) => (
              <p key={i} className={`text-xs ${i === 0 ? 'font-mono font-semibold text-white' : 'text-slate-300'} ${i > 0 ? 'mt-0.5' : ''}`}>
                {line}
              </p>
            ))}
          </div>

          {/* Legend */}
          <div className="absolute bottom-4 left-4 bg-slate-800/90 backdrop-blur-sm border border-slate-700 rounded-xl p-3 space-y-1.5">
            <p className="text-xs font-semibold text-slate-300 mb-2">Legend</p>
            {[
              { color: '#0ea5e9', label: 'Origin Account' },
              { color: '#ef4444', label: 'Fraud Account' },
              { color: '#a855f7', label: 'Circular Flow' },
              { color: '#334155', label: 'Normal Account' },
            ].map(({ color, label }) => (
              <div key={label} className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: color }} />
                <span className="text-xs text-slate-400">{label}</span>
              </div>
            ))}
            <p className="text-xs text-slate-500 pt-1 border-t border-slate-700 mt-1.5">Hover for details · click to pin</p>
          </div>
        </div>

        {/* Detail Panel — node or edge */}
        {selected?.kind === 'node' && (
          <div className="w-64 flex-shrink-0 border-l border-slate-800 bg-slate-900 p-4 space-y-4 overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Account Detail</h3>
              <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-white text-xs">✕</button>
            </div>

            <div className={`w-12 h-12 rounded-xl flex items-center justify-center mx-auto
              ${selected.data.isFraud ? 'bg-red-500/20 border-2 border-red-500' : 'bg-sky-500/20 border-2 border-sky-500'}`}>
              {selected.data.isFraud
                ? <AlertTriangle className="w-6 h-6 text-red-400" />
                : <Info className="w-6 h-6 text-sky-400" />
              }
            </div>

            <div className="space-y-2">
              {[
                { label: 'Account ID', value: selected.data.fullLabel || selected.data.id, mono: true },
                { label: 'Type',       value: selected.data.type },
                { label: 'Bank',       value: selected.data.bank || '—' },
                { label: 'Risk Level', value: selected.data.riskLevel || '—' },
                { label: 'Risk Score', value: `${selected.data.riskScore?.toFixed(1) || 0}/100` },
                { label: 'Tx Count',   value: selected.data.txCount || 0 },
                { label: 'Total Flow', value: `$${(selected.data.totalAmount || 0).toLocaleString()}` },
              ].map(({ label, value, mono }) => (
                <div key={label} className="flex justify-between gap-2">
                  <span className="text-xs text-slate-400">{label}</span>
                  <span className={`text-xs font-medium text-slate-200 text-right ${mono ? 'font-mono' : ''}`}>{String(value)}</span>
                </div>
              ))}
            </div>

            {selected.data.type === 'circular' && (
              <div className="bg-purple-950/40 border border-purple-800/40 rounded-lg p-3">
                <p className="text-xs text-purple-300 font-semibold mb-1">⟲ Circular Flow</p>
                <p className="text-xs text-purple-400">This account is part of a multi-hop money trail that loops back on itself — a classic layering pattern.</p>
              </div>
            )}
            {selected.data.isFraud && selected.data.type !== 'circular' && (
              <div className="bg-red-950/40 border border-red-800/40 rounded-lg p-3">
                <p className="text-xs text-red-300 font-semibold mb-1">⚠ Fraud Detected</p>
                <p className="text-xs text-red-400">This account is linked to flagged transactions. Recommend immediate investigation.</p>
              </div>
            )}
          </div>
        )}

        {selected?.kind === 'edge' && (
          <div className="w-64 flex-shrink-0 border-l border-slate-800 bg-slate-900 p-4 space-y-4 overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Transaction Detail</h3>
              <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-white text-xs">✕</button>
            </div>

            <div className={`w-12 h-12 rounded-xl flex items-center justify-center mx-auto
              ${selected.data.isFraud ? 'bg-red-500/20 border-2 border-red-500' : 'bg-sky-500/20 border-2 border-sky-500'}`}>
              <ArrowRightLeft className={`w-6 h-6 ${selected.data.isFraud ? 'text-red-400' : 'text-sky-400'}`} />
            </div>

            <div className="space-y-2">
              {[
                { label: 'From',      value: selected.data.source, mono: true },
                { label: 'To',        value: selected.data.target, mono: true },
                { label: 'Amount',    value: `$${(selected.data.amount || 0).toLocaleString()}` },
                { label: 'Format',    value: selected.data.format || '—' },
                { label: 'Risk Score',value: `${selected.data.riskScore?.toFixed(1) || 0}/100` },
                { label: 'Category',  value: selected.data.fraudCategory || 'Clean' },
              ].map(({ label, value, mono }) => (
                <div key={label} className="flex justify-between gap-2">
                  <span className="text-xs text-slate-400">{label}</span>
                  <span className={`text-xs font-medium text-slate-200 text-right ${mono ? 'font-mono' : ''}`}>{String(value)}</span>
                </div>
              ))}
            </div>

            {selected.data.fraudCategory === 'Circular Transaction' && (
              <div className="bg-purple-950/40 border border-purple-800/40 rounded-lg p-3">
                <p className="text-xs text-purple-300 font-semibold mb-1">⟲ Circular Flow</p>
                <p className="text-xs text-purple-400">Part of a multi-hop cycle where funds eventually return to an earlier account.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Generate realistic demo graph
function generateMockGraph(startTx) {
  const accounts = Array.from({ length: 18 }, (_, i) => `ACC${1000 + i}`)
  const nodes = [
    { id: accounts[0], label: accounts[0], type: 'origin', riskScore: 92, riskLevel: 'Critical', isFraud: true, bank: 'First Bank', txCount: 5, totalAmount: 450000 },
    ...accounts.slice(1, 7).map((a, i) => ({
      id: a, label: a, type: i < 3 ? 'circular' : 'normal',
      riskScore: i < 3 ? 70 + i * 10 : 20 - i * 2,
      riskLevel: i < 2 ? 'Critical' : i < 3 ? 'High' : 'Low',
      isFraud: i < 3, bank: 'Metro Bank', txCount: 2 + i, totalAmount: 100000 * (i + 1)
    })),
    ...accounts.slice(7).map((a, i) => ({
      id: a, label: a, type: 'normal', riskScore: 15 + i * 3, riskLevel: 'Low',
      isFraud: false, bank: 'City Bank', txCount: 1, totalAmount: 25000
    }))
  ]

  const edges = [
    { id: startTx, source: accounts[0], target: accounts[1], amount: 120000, format: 'Wire', isFraud: true, riskScore: 92, fraudCategory: 'Circular Transaction' },
    { id: 'e2', source: accounts[1], target: accounts[2], amount: 115000, format: 'Wire', isFraud: true, riskScore: 85, fraudCategory: 'Circular Transaction' },
    { id: 'e3', source: accounts[2], target: accounts[0], amount: 110000, format: 'Bitcoin', isFraud: true, riskScore: 90, fraudCategory: 'Circular Transaction' },
    ...accounts.slice(3, 7).map((a, i) => ({
      id: `e${i + 4}`, source: accounts[0], target: a, amount: 30000 * (i + 1), format: 'ACH', isFraud: false, riskScore: 30, fraudCategory: 'Clean'
    })),
    ...accounts.slice(7).map((a, i) => ({
      id: `e${i + 8}`, source: accounts[i % 4 + 1], target: a, amount: 15000, format: 'Cheque', isFraud: false, riskScore: 20, fraudCategory: 'Clean'
    }))
  ]

  return {
    originAccount: accounts[0], originBank: 'First Bank',
    depth: 3, nodeCount: nodes.length, edgeCount: edges.length,
    circularFlowCount: 1,
    nodes, edges,
    riskSummary: { maxRisk: 92, fraudNodes: 3, totalAmount: 1200000 }
  }
}
