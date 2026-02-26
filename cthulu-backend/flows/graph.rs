use std::collections::{HashMap, HashSet, VecDeque};

use crate::tasks::executors::ExecutionResult;
use crate::tasks::sources::ContentItem;

/// Unified output type for all node types in the DAG.
#[derive(Debug, Clone)]
pub enum NodeOutput {
    /// Content items from sources/filters.
    Items(Vec<ContentItem>),
    /// Text output from executors (includes ExecutionResult metadata).
    Text(String, Option<ExecutionResult>),
    /// Context variables injected by triggers (e.g. GitHub PR context).
    Context(HashMap<String, String>),
    /// No meaningful output (triggers, sinks).
    Empty,
    /// Error sentinel — downstream nodes are skipped.
    Failed,
}

impl NodeOutput {
    /// Merge multiple upstream outputs into a single input for a downstream node.
    ///
    /// Rules:
    /// - If any parent is `Failed`, the merge result is `Failed` (skip branch).
    /// - Multiple `Items` are concatenated.
    /// - Multiple `Context` maps are merged (later overwrites earlier on key conflict).
    /// - `Text` outputs are joined with newlines.
    /// - `Empty` is ignored.
    /// - Mixed types: Items + Context → Items with context vars ignored (context only
    ///   meaningful for executor prompt rendering, handled separately).
    pub fn merge(outputs: Vec<NodeOutput>) -> NodeOutput {
        if outputs.is_empty() {
            return NodeOutput::Empty;
        }
        if outputs.iter().any(|o| matches!(o, NodeOutput::Failed)) {
            return NodeOutput::Failed;
        }

        let mut items: Vec<ContentItem> = Vec::new();
        let mut texts: Vec<String> = Vec::new();
        let mut context: HashMap<String, String> = HashMap::new();
        let mut has_items = false;
        let mut has_text = false;
        let mut has_context = false;

        for output in outputs {
            match output {
                NodeOutput::Items(mut v) => {
                    has_items = true;
                    items.append(&mut v);
                }
                NodeOutput::Text(t, _) => {
                    has_text = true;
                    texts.push(t);
                }
                NodeOutput::Context(map) => {
                    has_context = true;
                    context.extend(map);
                }
                NodeOutput::Empty | NodeOutput::Failed => {}
            }
        }

        // Priority: Items > Text > Context > Empty
        if has_items {
            NodeOutput::Items(items)
        } else if has_text {
            NodeOutput::Text(texts.join("\n"), None)
        } else if has_context {
            NodeOutput::Context(context)
        } else {
            NodeOutput::Empty
        }
    }

    /// Extract as text for prompt rendering / sink delivery.
    pub fn as_text(&self) -> String {
        match self {
            NodeOutput::Items(items) => crate::tasks::pipeline::format_items(items),
            NodeOutput::Text(t, _) => t.clone(),
            NodeOutput::Context(map) => {
                map.iter()
                    .map(|(k, v)| format!("{k}: {v}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
            NodeOutput::Empty | NodeOutput::Failed => String::new(),
        }
    }

    /// Extract items if this is an Items variant, otherwise empty vec.
    pub fn as_items(&self) -> Vec<ContentItem> {
        match self {
            NodeOutput::Items(items) => items.clone(),
            _ => vec![],
        }
    }

    /// Extract context map if this is a Context variant.
    pub fn as_context(&self) -> Option<&HashMap<String, String>> {
        match self {
            NodeOutput::Context(map) => Some(map),
            _ => None,
        }
    }
}

/// Build adjacency maps from nodes and edges.
/// Returns (children_map, parents_map) where each maps node_id → set of connected node_ids.
pub fn build_adjacency(
    nodes: &[crate::flows::Node],
    edges: &[crate::flows::Edge],
) -> (HashMap<String, Vec<String>>, HashMap<String, Vec<String>>) {
    let node_ids: HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();

    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    let mut parents: HashMap<String, Vec<String>> = HashMap::new();

    // Initialize all nodes
    for node in nodes {
        children.entry(node.id.clone()).or_default();
        parents.entry(node.id.clone()).or_default();
    }

    for edge in edges {
        // Only include edges between nodes that exist in the flow
        if node_ids.contains(edge.source.as_str()) && node_ids.contains(edge.target.as_str()) {
            children
                .entry(edge.source.clone())
                .or_default()
                .push(edge.target.clone());
            parents
                .entry(edge.target.clone())
                .or_default()
                .push(edge.source.clone());
        }
    }

    (children, parents)
}

/// Topological sort using Kahn's algorithm over ALL nodes.
/// Returns node IDs in execution order. Returns Err if the graph has a cycle.
pub fn topo_sort(
    nodes: &[crate::flows::Node],
    edges: &[crate::flows::Edge],
) -> anyhow::Result<Vec<String>> {
    let (children, parents) = build_adjacency(nodes, edges);

    let mut in_degree: HashMap<String, usize> = HashMap::new();
    for node in nodes {
        in_degree.insert(node.id.clone(), parents.get(&node.id).map_or(0, |p| p.len()));
    }

    let mut queue: VecDeque<String> = in_degree
        .iter()
        .filter(|&(_, &deg)| deg == 0)
        .map(|(id, _)| id.clone())
        .collect();

    let mut sorted = Vec::with_capacity(nodes.len());

    while let Some(node_id) = queue.pop_front() {
        sorted.push(node_id.clone());
        if let Some(neighbors) = children.get(&node_id) {
            for next in neighbors {
                let deg = in_degree.get_mut(next).unwrap();
                *deg -= 1;
                if *deg == 0 {
                    queue.push_back(next.clone());
                }
            }
        }
    }

    if sorted.len() != nodes.len() {
        anyhow::bail!(
            "flow graph has a cycle ({} of {} nodes sorted)",
            sorted.len(),
            nodes.len()
        );
    }

    Ok(sorted)
}

/// Group topologically-sorted nodes into levels for parallel execution.
/// Level 0 = roots (no parents), level N = max(parent levels) + 1.
/// Returns Vec<Vec<node_id>> where each inner vec is one level.
pub fn compute_levels(
    sorted: &[String],
    parents: &HashMap<String, Vec<String>>,
) -> Vec<Vec<String>> {
    let mut node_level: HashMap<&str, usize> = HashMap::new();
    let mut max_level: usize = 0;

    for node_id in sorted {
        let level = parents
            .get(node_id.as_str())
            .map(|pids| {
                pids.iter()
                    .filter_map(|p| node_level.get(p.as_str()))
                    .max()
                    .map(|m| m + 1)
                    .unwrap_or(0)
            })
            .unwrap_or(0);

        node_level.insert(node_id.as_str(), level);
        if level > max_level {
            max_level = level;
        }
    }

    let mut levels: Vec<Vec<String>> = vec![Vec::new(); max_level + 1];
    for node_id in sorted {
        let level = node_level[node_id.as_str()];
        levels[level].push(node_id.clone());
    }

    levels
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flows::{Edge, Node, NodeType, Position};

    fn make_node(id: &str, node_type: NodeType) -> Node {
        Node {
            id: id.to_string(),
            node_type,
            kind: "test".to_string(),
            config: serde_json::json!({}),
            position: Position { x: 0.0, y: 0.0 },
            label: id.to_string(),
        }
    }

    fn make_edge(source: &str, target: &str) -> Edge {
        Edge {
            id: format!("{source}->{target}"),
            source: source.to_string(),
            target: target.to_string(),
        }
    }

    #[test]
    fn test_topo_sort_linear() {
        let nodes = vec![
            make_node("t1", NodeType::Trigger),
            make_node("s1", NodeType::Source),
            make_node("e1", NodeType::Executor),
            make_node("k1", NodeType::Sink),
        ];
        let edges = vec![
            make_edge("t1", "s1"),
            make_edge("s1", "e1"),
            make_edge("e1", "k1"),
        ];

        let sorted = topo_sort(&nodes, &edges).unwrap();
        assert_eq!(sorted.len(), 4);

        // t1 must come before s1, s1 before e1, e1 before k1
        let pos = |id: &str| sorted.iter().position(|s| s == id).unwrap();
        assert!(pos("t1") < pos("s1"));
        assert!(pos("s1") < pos("e1"));
        assert!(pos("e1") < pos("k1"));
    }

    #[test]
    fn test_topo_sort_diamond() {
        //   t1
        //  / \
        // s1  s2
        //  \ /
        //   e1
        let nodes = vec![
            make_node("t1", NodeType::Trigger),
            make_node("s1", NodeType::Source),
            make_node("s2", NodeType::Source),
            make_node("e1", NodeType::Executor),
        ];
        let edges = vec![
            make_edge("t1", "s1"),
            make_edge("t1", "s2"),
            make_edge("s1", "e1"),
            make_edge("s2", "e1"),
        ];

        let sorted = topo_sort(&nodes, &edges).unwrap();
        assert_eq!(sorted.len(), 4);

        let pos = |id: &str| sorted.iter().position(|s| s == id).unwrap();
        assert!(pos("t1") < pos("s1"));
        assert!(pos("t1") < pos("s2"));
        assert!(pos("s1") < pos("e1"));
        assert!(pos("s2") < pos("e1"));
    }

    #[test]
    fn test_topo_sort_cycle_detection() {
        let nodes = vec![
            make_node("a", NodeType::Source),
            make_node("b", NodeType::Source),
        ];
        let edges = vec![make_edge("a", "b"), make_edge("b", "a")];

        let result = topo_sort(&nodes, &edges);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("cycle"));
    }

    #[test]
    fn test_compute_levels_linear() {
        let nodes = vec![
            make_node("t1", NodeType::Trigger),
            make_node("s1", NodeType::Source),
            make_node("e1", NodeType::Executor),
        ];
        let edges = vec![make_edge("t1", "s1"), make_edge("s1", "e1")];

        let sorted = topo_sort(&nodes, &edges).unwrap();
        let (_, parents) = build_adjacency(&nodes, &edges);
        let levels = compute_levels(&sorted, &parents);

        assert_eq!(levels.len(), 3);
        assert_eq!(levels[0], vec!["t1"]);
        assert_eq!(levels[1], vec!["s1"]);
        assert_eq!(levels[2], vec!["e1"]);
    }

    #[test]
    fn test_compute_levels_parallel_sources() {
        //   t1
        //  / \
        // s1  s2
        //  \ /
        //   e1
        let nodes = vec![
            make_node("t1", NodeType::Trigger),
            make_node("s1", NodeType::Source),
            make_node("s2", NodeType::Source),
            make_node("e1", NodeType::Executor),
        ];
        let edges = vec![
            make_edge("t1", "s1"),
            make_edge("t1", "s2"),
            make_edge("s1", "e1"),
            make_edge("s2", "e1"),
        ];

        let sorted = topo_sort(&nodes, &edges).unwrap();
        let (_, parents) = build_adjacency(&nodes, &edges);
        let levels = compute_levels(&sorted, &parents);

        assert_eq!(levels.len(), 3);
        assert_eq!(levels[0], vec!["t1"]);
        // s1 and s2 are at same level (parallel)
        assert_eq!(levels[1].len(), 2);
        assert!(levels[1].contains(&"s1".to_string()));
        assert!(levels[1].contains(&"s2".to_string()));
        assert_eq!(levels[2], vec!["e1"]);
    }

    #[test]
    fn test_merge_empty() {
        let result = NodeOutput::merge(vec![]);
        assert!(matches!(result, NodeOutput::Empty));
    }

    #[test]
    fn test_merge_failed_propagation() {
        let result = NodeOutput::merge(vec![
            NodeOutput::Items(vec![]),
            NodeOutput::Failed,
        ]);
        assert!(matches!(result, NodeOutput::Failed));
    }

    #[test]
    fn test_merge_items_concatenation() {
        let item1 = ContentItem {
            title: "A".to_string(),
            url: String::new(),
            summary: String::new(),
            published: None,
            image_url: None,
        };
        let item2 = ContentItem {
            title: "B".to_string(),
            url: String::new(),
            summary: String::new(),
            published: None,
            image_url: None,
        };

        let result = NodeOutput::merge(vec![
            NodeOutput::Items(vec![item1]),
            NodeOutput::Items(vec![item2]),
        ]);
        match result {
            NodeOutput::Items(items) => {
                assert_eq!(items.len(), 2);
                assert_eq!(items[0].title, "A");
                assert_eq!(items[1].title, "B");
            }
            _ => panic!("expected Items"),
        }
    }

    #[test]
    fn test_merge_context_maps() {
        let mut ctx1 = HashMap::new();
        ctx1.insert("a".to_string(), "1".to_string());
        let mut ctx2 = HashMap::new();
        ctx2.insert("b".to_string(), "2".to_string());

        let result = NodeOutput::merge(vec![
            NodeOutput::Context(ctx1),
            NodeOutput::Context(ctx2),
        ]);
        match result {
            NodeOutput::Context(map) => {
                assert_eq!(map.len(), 2);
                assert_eq!(map["a"], "1");
                assert_eq!(map["b"], "2");
            }
            _ => panic!("expected Context"),
        }
    }

    #[test]
    fn test_merge_text() {
        let result = NodeOutput::merge(vec![
            NodeOutput::Text("hello".to_string(), None),
            NodeOutput::Text("world".to_string(), None),
        ]);
        match result {
            NodeOutput::Text(t, _) => assert_eq!(t, "hello\nworld"),
            _ => panic!("expected Text"),
        }
    }

    #[test]
    fn test_merge_empty_ignored() {
        let result = NodeOutput::merge(vec![
            NodeOutput::Empty,
            NodeOutput::Text("hello".to_string(), None),
            NodeOutput::Empty,
        ]);
        match result {
            NodeOutput::Text(t, _) => assert_eq!(t, "hello"),
            _ => panic!("expected Text"),
        }
    }

    #[test]
    fn test_build_adjacency() {
        let nodes = vec![
            make_node("a", NodeType::Trigger),
            make_node("b", NodeType::Source),
            make_node("c", NodeType::Executor),
        ];
        let edges = vec![make_edge("a", "b"), make_edge("b", "c")];

        let (children, parents) = build_adjacency(&nodes, &edges);

        assert_eq!(children["a"], vec!["b"]);
        assert_eq!(children["b"], vec!["c"]);
        assert!(children["c"].is_empty());

        assert!(parents["a"].is_empty());
        assert_eq!(parents["b"], vec!["a"]);
        assert_eq!(parents["c"], vec!["b"]);
    }
}
