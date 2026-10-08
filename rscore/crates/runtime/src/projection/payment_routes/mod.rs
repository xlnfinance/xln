//! Canonical pure route solver shared by native quotes and fresh payment preparation.
use num_bigint::BigInt;
use xln_rscore_entity_kernel::required_htlc_inbound;
mod profiles;
pub use profiles::edges;
#[derive(Clone, Debug)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub capacity: BigInt,
    pub base: BigInt,
    pub ppm: u32,
}
#[derive(Clone)]
pub struct Route {
    pub path: Vec<String>,
    pub amounts: Vec<BigInt>,
    pub fees: Vec<BigInt>,
    pub total: BigInt,
    pub probability: f64,
}
pub fn edge<'a>(edges: &'a [Edge], from: &str, to: &str) -> Option<&'a Edge> {
    edges.iter().find(|e| e.from == from && e.to == to)
}
fn build(edges: &[Edge], path: Vec<String>, amount: &BigInt) -> Result<Route, String> {
    let selected = path
        .windows(2)
        .map(|pair| edge(edges, &pair[0], &pair[1]).ok_or("E_INTERNAL:ROUTE_EDGE_MISSING"))
        .collect::<Result<Vec<_>, _>>()?;
    let mut amounts = vec![amount.clone(); selected.len()];
    for i in (1..selected.len()).rev() {
        amounts[i - 1] = required_htlc_inbound(&amounts[i], selected[i].ppm, &selected[i].base)?;
    }
    let fees = (0..selected.len())
        .map(|i| {
            if i == 0 {
                BigInt::from(0)
            } else {
                &amounts[i - 1] - &amounts[i]
            }
        })
        .collect();
    let probability = selected
        .iter()
        .enumerate()
        .try_fold(1.0, |p, (i, e)| -> Result<f64, String> {
            if e.capacity <= BigInt::from(0) {
                return Ok(p);
            }
            // Float conversion affects only the advisory probability, never money or ordering.
            let amount = amounts[i]
                .to_string()
                .parse::<f64>()
                .map_err(|error| format!("E_INTERNAL:PROBABILITY:{error}"))?;
            let capacity = e
                .capacity
                .to_string()
                .parse::<f64>()
                .map_err(|error| format!("E_INTERNAL:PROBABILITY:{error}"))?;
            Ok(p * (-2.0 * amount / capacity).exp())
        })?
        .clamp(0.01, 1.0);
    Ok(Route {
        total: amounts[0].clone(),
        path,
        amounts,
        fees,
        probability,
    })
}
pub fn search(
    edges: &[Edge],
    source: &str,
    target: &str,
    amount: &BigInt,
    funding: Option<&str>,
) -> Result<Vec<Route>, String> {
    if source == target {
        return Ok(Vec::new());
    }
    let mut queue = vec![(BigInt::from(0), vec![source.to_owned()])];
    let mut routes = Vec::new();
    for _ in 0..4096 {
        if queue.is_empty() || routes.len() >= 100 {
            break;
        }
        queue.sort_by(|a, b| a.0.cmp(&b.0)); // Stable tie order matches TS Array.sort.
        let (_, path) = queue.remove(0);
        let current = path.last().ok_or("E_INTERNAL:ROUTE_PATH_EMPTY")?;
        if current == target {
            let route = build(edges, path, amount)?;
            if route.path.windows(2).enumerate().all(|(i, pair)| {
                (i == 0 && funding.is_some())
                    || edge(edges, &pair[0], &pair[1])
                        .is_some_and(|e| route.amounts[i] <= e.capacity)
            }) {
                routes.push(route);
            }
            continue;
        }
        for e in edges.iter().filter(|e| &e.from == current) {
            if (current == source && funding.is_some_and(|f| e.to != f)) || path.contains(&e.to) {
                continue;
            }
            if !(current == source && funding.is_some()) && *amount > e.capacity {
                continue;
            }
            let mut next = path.clone();
            next.push(e.to.clone());
            let quote = build(edges, next.clone(), amount)?;
            queue.push((&quote.total - amount, next));
        }
    }
    routes.sort_by(|a, b| a.total.cmp(&b.total));
    Ok(routes)
}

#[cfg(test)]
mod tests;
