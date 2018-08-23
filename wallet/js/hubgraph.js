window.drawHubgraph = (graph) => {
  var svg = d3.select('#hubgraph'),
    width = +svg.attr('width'),
    height = +svg.attr('height')

  var radius = 15

  //set up the simulation and add forces
  var simulation = d3.forceSimulation().nodes(graph.nodes)

  var link_force = d3.forceLink(graph.links).id(function(d) {
    return d.id
  })

  var charge_force = d3.forceManyBody().strength(-100)

  var center_force = d3.forceCenter(width / 2, height / 2)

  simulation
    .force('charge_force', charge_force)
    .force('center_force', center_force)
    .force('links', link_force)

  //add tick instructions:
  simulation.on('tick', tickActions)

  //add encompassing group for the zoom
  var g = svg.append('g').attr('class', 'everything')

  //draw lines for the links
  var link = g
    .append('g')
    .attr('class', 'links')
    .selectAll('line')
    .data(graph.links)
    .enter()
    .append('line')
    .attr('stroke-width', 2)
    .style('stroke', linkColour)

  //draw circles for the nodes
  window.node = g
    .append('g')
    .attr('class', 'nodes')
    .selectAll('g')
    .data(graph.nodes)
    .enter()
    .append('g')
    .append('circle')
    .attr('r', radius)

  node
    .append('title')
    .attr('x', 6)
    .attr('y', 3)
    .text((d) => {
      return d.handle
    })

  node
    .append('title')
    .attr('x', 6)
    .attr('y', 3)
    .text((d) => {
      return d.handle
    })

  //add drag capabilities
  var drag_handler = d3
    .drag()
    .on('start', drag_start)
    .on('drag', drag_drag)
    .on('end', drag_end)

  drag_handler(node)

  //add zoom capabilities
  var zoom_handler = d3.zoom().on('zoom', zoom_actions)

  zoom_handler(svg)

  /** Functions **/

  //Function to choose what color circle we have
  //Let's return blue for males and red for females
  function circleColour(d) {
    if (d.sex == 'M') {
      return 'blue'
    } else {
      return 'pink'
    }
  }

  //Function to choose the line colour and thickness
  //If the link type is "A" return green
  //If the link type is "E" return red
  function linkColour(d) {
    if (d.type == 'A') {
      return 'green'
    } else {
      return 'red'
    }
  }

  //Drag functions
  //d is the node
  function drag_start(d) {
    if (!d3.event.active) simulation.alphaTarget(0.3).restart()
    d.fx = d.x
    d.fy = d.y
  }

  //make sure you can't drag the circle outside the box
  function drag_drag(d) {
    d.fx = d3.event.x
    d.fy = d3.event.y
  }

  function drag_end(d) {
    if (!d3.event.active) simulation.alphaTarget(0)
    d.fx = null
    d.fy = null
  }

  //Zoom functions
  function zoom_actions() {
    g.attr('transform', d3.event.transform)
  }

  function tickActions() {
    //update circle positions each tick of the simulation
    node
      .attr('cx', function(d) {
        return d.x
      })
      .attr('cy', function(d) {
        return d.y
      })

    //update link positions
    link
      .attr('x1', function(d) {
        return d.source.x
      })
      .attr('y1', function(d) {
        return d.source.y
      })
      .attr('x2', function(d) {
        return d.target.x
      })
      .attr('y2', function(d) {
        return d.target.y
      })
  }
}
