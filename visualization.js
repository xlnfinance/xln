class HubAndSpokeVisualization {
    constructor() {
        this.svg = null;
        this.width = 0;
        this.height = 0;
        this.centerX = 0;
        this.centerY = 0;
        this.hubRadius = 10;
        this.userRadius = 5;
        this.dotRadius = 3;
        this.positionVariation = 0;
        this.hubPositionVariation = 0;
        this.motionTime = 1000;
        this.hubTime = 500;
        this.transactionRate = 2;
        this.seed = Math.random();
        
        this.isRunning = false;
        this.transactionInterval = null;
        this.transactionCounter = 0;
        
        this.rebalanceRate = 1;
        this.broadcastStyle = 'ripple';
        this.depositories = [];
        this.pendingL1Transactions = new Map();
        this.rebalanceInterval = null;
        
        this.onchainTxSize = 8;
        this.numDepositories = 3;
        this.depositoryPosition = 'top';
        
        this.blockCounter = 0;
        this.blockSize = 12;
        this.blockPadding = 2;
        this.blockchains = new Map();
        
        this.depositorySpots = new Map();
        
        this.blockCounters = new Map();
        
        this.l2TPS = 1.0;  // Default L2 TPS (formerly transactionRate)
        this.l1TPS = 1.0;  // Default L1 TPS (formerly rebalanceRate)
        
        this.colorSchemes = {
            'anthropic': {
                hub: '#1A1A1A',
                user: '#2D2D2D',
                transaction: '#FFFFFF',
                onchainTx: '#FFD700',
                depository: '#666666',
                ripple: '#FFD700'
            },
            'modern': {
                hub: '#0066FF',
                user: '#4D4D4D',
                transaction: '#FFFFFF',
                onchainTx: '#00CC99',
                depository: '#333333',
                ripple: '#00CC99'
            },
            'classic': {
                hub: '#FFD700',
                user: '#4169E1',
                transaction: '#FFFFFF',
                onchainTx: '#FFD700',
                depository: '#666666',
                ripple: '#FFD700'
            }
        };
        this.currentColorScheme = 'anthropic';
        
        this.loadStateFromHash();
        this.init();
    }

    loadStateFromHash() {
        try {
            if (location.hash) {
                const state = JSON.parse(decodeURIComponent(location.hash.slice(1)));
                
                // Load TPS values
                if (state.l2TPS !== undefined) {
                    this.l2TPS = state.l2TPS;
                    const l2Control = document.getElementById('l2TPSControl');
                    const l2Value = document.getElementById('l2TPSValue');
                    if (l2Control) l2Control.value = this.l2TPS;
                    if (l2Value) l2Value.textContent = this.l2TPS;
                }
                
                if (state.l1TPS !== undefined) {
                    this.l1TPS = state.l1TPS;
                    const l1Control = document.getElementById('l1TPSControl');
                    const l1Value = document.getElementById('l1TPSValue');
                    if (l1Control) l1Control.value = this.l1TPS;
                    if (l1Value) l1Value.textContent = this.l1TPS;
                }

                // ... rest of state loading ...
            }
        } catch (e) {
            console.error('Failed to load state from hash:', e);
        }
    }

    saveStateToHash() {
        const state = {
            hubRadius: this.hubRadius,
            userRadius: this.userRadius,
            dotRadius: this.dotRadius,
            positionVariation: this.positionVariation,
            hubPositionVariation: this.hubPositionVariation,
            motionTime: this.motionTime,
            hubTime: this.hubTime,
            l2TPS: this.l2TPS,
            l1TPS: this.l1TPS,
            broadcastStyle: this.broadcastStyle,
            colorScheme: this.currentColorScheme,
            onchainTxSize: this.onchainTxSize,
            numDepositories: this.numDepositories,
            depositoryPosition: this.depositoryPosition,
            blockSize: this.blockSize,
            numHubs: parseInt(document.getElementById('hubsControl').value),
            numUsers: parseInt(document.getElementById('usersControl').value)
        };
        
        location.hash = encodeURIComponent(JSON.stringify(state));
    }

    getDepositoryPositions() {
        const positions = [];
        const spacing = 150;
        const numDepositories = this.numDepositories;
        
        switch (this.depositoryPosition) {
            case 'top':
                for (let i = 0; i < numDepositories; i++) {
                    positions.push({
                        x: this.width/2 + (i - (numDepositories-1)/2) * spacing,
                        y: 100
                    });
                }
                break;
            case 'bottom':
                for (let i = 0; i < numDepositories; i++) {
                    positions.push({
                        x: this.width/2 + (i - (numDepositories-1)/2) * spacing,
                        y: this.height - 100
                    });
                }
                break;
            case 'left':
                for (let i = 0; i < numDepositories; i++) {
                    positions.push({
                        x: 100,
                        y: this.height/2 + (i - (numDepositories-1)/2) * spacing
                    });
                }
                break;
            case 'right':
                for (let i = 0; i < numDepositories; i++) {
                    positions.push({
                        x: this.width - 100,
                        y: this.height/2 + (i - (numDepositories-1)/2) * spacing
                    });
                }
                break;
        }
        return positions;
    }

    init() {
        // Get container dimensions
        const container = document.getElementById('visualization');
        if (!container) {
            console.error('Visualization container not found');
            return;
        }
        
        this.width = container.clientWidth;
        this.height = container.clientHeight;
        this.centerX = this.width / 2;
        this.centerY = this.height / 2;

        // Ensure all controls exist before trying to set their values
        const requiredControls = [
            'hubsControl', 'hubsValue',
            'usersControl', 'usersValue'
            // Remove blockSize from required controls for now
        ];

        const missingControls = requiredControls.filter(id => !document.getElementById(id));
        if (missingControls.length > 0) {
            console.error('Missing controls:', missingControls);
            return;
        }

        // Set initial values for controls with proper defaults
        const state = location.hash ? 
            JSON.parse(decodeURIComponent(location.hash.slice(1))) : 
            { numHubs: 3, numUsers: 20 }; // Ensure default values

        // Update all control values with proper defaults
        document.getElementById('hubsControl').value = state.numHubs ?? 3;
        document.getElementById('hubsValue').textContent = state.numHubs ?? 3;
        document.getElementById('usersControl').value = state.numUsers ?? 20;
        document.getElementById('usersValue').textContent = state.numUsers ?? 20;

        // Optional block size control initialization
        const blockSizeControl = document.getElementById('blockSizeControl');
        const blockSizeValue = document.getElementById('blockSizeValue');
        if (blockSizeControl && blockSizeValue) {
            blockSizeControl.value = this.blockSize;
            blockSizeValue.textContent = this.blockSize;
        }

        // Initial render
        this.updateVisualization();

        // Initialize controls
        this.initializeControls();

        // Add transaction control
        const transactionButton = document.getElementById('transactionControl');
        if (transactionButton) {
            transactionButton.addEventListener('click', () => this.toggleTransactions());
        }

        // Start transactions after a small delay
        setTimeout(() => {
            this.toggleTransactions();
            this.startRebalanceTransactions();
        }, 100);

        // Add legend
        this.createLegend();
    }

    initializeControls() {
        // Update transaction rate slider limits
        const rateControl = document.getElementById('rebalanceRateControl');
        if (rateControl) {
            rateControl.min = "0.1";
            rateControl.max = "100";
            rateControl.step = "0.1";
        }

        // Add depository position control
        const positionControl = document.getElementById('depositoryPositionControl');
        if (positionControl) {
            positionControl.addEventListener('change', (e) => {
                this.depositoryPosition = e.target.value;
                
                // Clear existing transactions
                this.svg.selectAll('.rebalance').remove();
                this.depositories.forEach(d => {
                    this.depositorySpots.get(d.id).clear();
                    d.pendingTx = 0;
                });
                
                this.updateVisualization();
                this.saveStateToHash();
            });
        }

        // Update values display and handle changes
        const controls = {
            'motionTime': (val) => this.motionTime = parseInt(val),
            'hubTime': (val) => this.hubTime = parseInt(val),
            'rate': (val) => {
                this.transactionRate = parseFloat(val);
                if (this.isRunning) {
                    this.startTransactions();
                }
            },
            'rebalanceRate': (val) => {
                this.rebalanceRate = parseFloat(val);
                if (this.isRunning) {
                    this.startRebalanceTransactions();
                }
            },
            'hubs': (val) => {
                const numHubs = parseInt(val);
                document.getElementById('hubsValue').textContent = numHubs;
                this.updateVisualization();
            },
            'users': (val) => {
                const numUsers = parseInt(val);
                document.getElementById('usersValue').textContent = numUsers;
                this.updateVisualization();
            },
            'variation': (val) => {
                this.positionVariation = parseInt(val);
                this.updateVisualization();
            },
            'hubVariation': (val) => {
                this.hubPositionVariation = parseInt(val);
                this.updateVisualization();
            },
            'hubSize': (val) => {
                this.hubRadius = parseInt(val);
                this.updateVisualization();
            },
            'userSize': (val) => {
                this.userRadius = parseInt(val);
                this.updateVisualization();
            },
            'dotSize': (val) => {
                this.dotRadius = parseInt(val);
                this.updateVisualization();
            },
            'blockSize': (val) => {
                this.blockSize = parseInt(val);
                // Reset depositories when block size changes
                this.depositories.forEach(d => {
                    this.depositorySpots.get(d.id).clear();
                    d.pendingTx = 0;
                });
                // Clear all pending transactions
                this.svg.selectAll('.rebalance').remove();
                this.updateVisualization();
            }
        };

        // Add listeners for all controls
        Object.keys(controls).forEach(control => {
            const slider = document.getElementById(`${control}Control`);
            const value = document.getElementById(`${control}Value`);
            
            if (slider && value) {
                slider.addEventListener('input', (e) => {
                    value.textContent = e.target.value;
                    controls[control](e.target.value);
                    this.saveStateToHash();
                });
            }
        });

        // Add broadcast style control listener
        const broadcastStyleControl = document.getElementById('broadcastStyleControl');
        if (broadcastStyleControl) {
            broadcastStyleControl.addEventListener('change', (e) => {
                this.broadcastStyle = e.target.value;
                this.saveStateToHash();
            });
        }

        // Add specific handler for rebalance rate
        const rebalanceControl = document.getElementById('rebalanceRateControl');
        if (rebalanceControl) {
            rebalanceControl.addEventListener('input', (e) => {
                this.rebalanceRate = parseFloat(e.target.value);
                document.getElementById('rebalanceRateValue').textContent = this.rebalanceRate;
                
                // Restart with new rate if running
                if (this.isRunning) {
                    this.startRebalanceTransactions();
                }
                
                this.saveStateToHash();
            });
        }

        // Add specific handlers for depository and onchain tx controls
        const depositoryControl = document.getElementById('depositoriesControl');
        if (depositoryControl) {
            depositoryControl.addEventListener('input', (e) => {
                this.numDepositories = parseInt(e.target.value);
                document.getElementById('depositoriesValue').textContent = this.numDepositories;
                this.updateVisualization();
                this.saveStateToHash();
            });
        }

        const onchainSizeControl = document.getElementById('onchainSizeControl');
        if (onchainSizeControl) {
            onchainSizeControl.addEventListener('input', (e) => {
                this.onchainTxSize = parseInt(e.target.value);
                document.getElementById('onchainSizeValue').textContent = this.onchainTxSize;
                
                // Clear existing transactions and update visualization
                this.svg.selectAll('.rebalance').remove();
                this.depositories.forEach(d => {
                    this.depositorySpots.get(d.id).clear();
                    d.pendingTx = 0;
                });
                
                this.updateVisualization();
                this.saveStateToHash();
            });
        }

        // Add color scheme control
        const colorSchemeControl = document.getElementById('colorSchemeControl');
        if (colorSchemeControl) {
            colorSchemeControl.addEventListener('change', (e) => {
                this.currentColorScheme = e.target.value;
                this.updateVisualization();
                this.saveStateToHash();
            });
        }

        // Update TPS controls
        const l2TPSControl = document.getElementById('l2TPSControl');
        if (l2TPSControl) {
            l2TPSControl.addEventListener('input', (e) => {
                this.l2TPS = parseFloat(e.target.value);
                document.getElementById('l2TPSValue').textContent = this.l2TPS;
                if (this.isRunning) {
                    this.startTransactions();
                }
                this.saveStateToHash();
            });
        }

        const l1TPSControl = document.getElementById('l1TPSControl');
        if (l1TPSControl) {
            l1TPSControl.addEventListener('input', (e) => {
                this.l1TPS = parseFloat(e.target.value);
                document.getElementById('l1TPSValue').textContent = this.l1TPS;
                if (this.isRunning) {
                    this.startRebalanceTransactions();
                }
                this.saveStateToHash();
            });
        }
    }

    updateVisualization() {
        // First, completely clear the visualization container
        d3.select('#visualization').selectAll('svg').remove();

        // Create new SVG
        this.svg = d3.select('#visualization')
            .append('svg')
            .attr('width', this.width)
            .attr('height', this.height);

        const numHubs = parseInt(document.getElementById('hubsControl').value);
        const numUsers = parseInt(document.getElementById('usersControl').value);

        // Create hubs
        this.hubs = Array.from({length: numHubs}, (_, i) => {
            const angle = 2 * Math.PI * i / numHubs;
            const variation = this.hubPositionVariation;
            const distance = 100 + (Math.random() - 0.5) * variation;
            return {
                id: i,
                isHub: true,
                x: this.centerX + distance * Math.cos(angle),
                y: this.centerY + distance * Math.sin(angle)
            };
        });

        // Create users with position variation
        this.users = Array.from({length: numUsers}, (_, i) => {
            const angle = 2 * Math.PI * i / numUsers;
            const variation = this.positionVariation;
            const distance = 200 + (Math.random() - 0.5) * variation;
            return {
                id: i,
                isHub: false,
                x: this.centerX + distance * Math.cos(angle),
                y: this.centerY + distance * Math.sin(angle)
            };
        });

        // Draw connections
        this.drawConnections();
        
        // Draw hubs
        this.svg.selectAll('.hub')
            .data(this.hubs)
            .join('circle')
            .attr('class', 'hub')
            .attr('cx', d => d.x)
            .attr('cy', d => d.y)
            .attr('r', this.hubRadius)
            .attr('fill', '#9C27B0')
            .attr('filter', 'url(#glow)');

        // Draw users
        this.svg.selectAll('.user')
            .data(this.users)
            .join('circle')
            .attr('class', 'user')
            .attr('cx', d => d.x)
            .attr('cy', d => d.y)
            .attr('r', this.userRadius)
            .attr('fill', '#2196F3');

        // Add glow filter
        const defs = this.svg.append('defs');
        const filter = defs.append('filter')
            .attr('id', 'glow');
        filter.append('feGaussianBlur')
            .attr('stdDeviation', '3')
            .attr('result', 'coloredBlur');
        const feMerge = filter.append('feMerge');
        feMerge.append('feMergeNode')
            .attr('in', 'coloredBlur');
        feMerge.append('feMergeNode')
            .attr('in', 'SourceGraphic');

        // Add L1 separation line
        const lineY = this.height * 0.15;
        this.svg.append('line')
            .attr('x1', 0)
            .attr('y1', lineY)
            .attr('x2', this.width)
            .attr('y2', lineY)
            .attr('stroke', '#666')
            .attr('stroke-width', 2)
            .attr('stroke-dasharray', '5,5');

        // Get depository positions and create depositories
        const positions = this.getDepositoryPositions();
        this.depositories = positions.map((pos, i) => ({
            id: i,
            x: pos.x,
            y: pos.y,
            pendingTx: 0
        }));

        // Reset block counters and initialize counter displays
        this.blockCounters = new Map();
        this.depositories.forEach(d => {
            this.blockCounters.set(d.id, 0);
            
            // Add initial counter display
            this.svg.append('text')
                .attr('class', `depository-${d.id}-counter`)
                .attr('x', d.x)
                .attr('y', d.y - 40)
                .attr('text-anchor', 'middle')
                .attr('fill', 'white')
                .attr('font-size', '16px')
                .text('#0');
        });

        // Initialize spots tracking
        this.depositorySpots = new Map();
        this.depositories.forEach(d => {
            this.depositorySpots.set(d.id, new Set());
        });

        // Draw depositories with larger boxes to fit 12 transactions
        this.svg.selectAll('.depository')
            .data(this.depositories)
            .join('g')
            .attr('class', 'depository')
            .attr('transform', d => `translate(${d.x},${d.y})`)
            .call(g => {
                g.selectAll('*').remove();
                
                // Draw larger depository box
                g.append('rect')
                    .attr('x', -35)
                    .attr('y', -25)
                    .attr('width', 120)  // Wider to fit 6 transactions horizontally
                    .attr('height', 50)  // Taller to fit 2 rows
                    .attr('fill', 'none')
                    .attr('stroke', '#666')
                    .attr('stroke-width', 1);
            });
    }

    drawConnections() {
        // Draw hub-to-hub connections
        for (let i = 0; i < this.hubs.length; i++) {
            for (let j = i + 1; j < this.hubs.length; j++) {
                this.svg.append('line')
                    .attr('x1', this.hubs[i].x)
                    .attr('y1', this.hubs[i].y)
                    .attr('x2', this.hubs[j].x)
                    .attr('y2', this.hubs[j].y)
                    .attr('stroke', 'rgba(255, 255, 255, 0.2)')
                    .attr('stroke-width', 1);
            }
        }

        // Draw user-to-hub connections
        this.users.forEach(user => {
            // Connect to nearest 1-4 hubs
            const numConnections = Math.floor(Math.random() * 4) + 1;
            const hubDistances = this.hubs.map((hub, index) => ({
                index,
                distance: Math.hypot(hub.x - user.x, hub.y - user.y)
            })).sort((a, b) => a.distance - b.distance);

            for (let i = 0; i < Math.min(numConnections, this.hubs.length); i++) {
                const hub = this.hubs[hubDistances[i].index];
                this.svg.append('line')
                    .attr('x1', user.x)
                    .attr('y1', user.y)
                    .attr('x2', hub.x)
                    .attr('y2', hub.y)
                    .attr('stroke', 'rgba(255, 255, 255, 0.5)')
                    .attr('stroke-width', 1);
            }
        });
    }

    toggleTransactions() {
        const button = document.getElementById('transactionControl');
        this.isRunning = !this.isRunning;
        
        if (this.isRunning) {
            button.textContent = 'Stop Transactions';
            button.classList.add('active');
            this.startTransactions();
            this.startRebalanceTransactions();
        } else {
            button.textContent = 'Start Transactions';
            button.classList.remove('active');
            if (this.transactionInterval) clearInterval(this.transactionInterval);
            if (this.rebalanceInterval) clearInterval(this.rebalanceInterval);
        }
    }

    startTransactions() {
        if (this.transactionInterval) {
            clearInterval(this.transactionInterval);
        }
        const interval = Math.max(20, Math.floor(1000 / this.l2TPS));
        this.transactionInterval = setInterval(() => {
            if (this.isRunning) this.createTransaction();
        }, interval);
    }

    stopTransactions() {
        this.isRunning = false;
        if (this.transactionInterval) {
            clearInterval(this.transactionInterval);
            this.transactionInterval = null;
        }
    }

    createTransaction() {
        const source = this.users[Math.floor(Math.random() * this.users.length)];
        const hub = this.hubs[Math.floor(Math.random() * this.hubs.length)];
        
        const dot = this.svg.append('circle')
            .attr('class', 'transaction')
            .attr('cx', source.x)
            .attr('cy', source.y)
            .attr('r', this.dotRadius)
            .attr('fill', '#FFF');

        // First leg: user to hub using motionTime
        dot.transition()
            .duration(this.motionTime)
            .attr('cx', hub.x)
            .attr('cy', hub.y)
            .on('end', () => {
                // Second leg: hub to destination using hubTime
                const dest = this.users[Math.floor(Math.random() * this.users.length)];
                dot.transition()
                    .duration(this.hubTime)
                    .attr('cx', dest.x)
                    .attr('cy', dest.y)
                    .on('end', function() {
                        d3.select(this).remove();
                    });
            });
    }

    startRebalanceTransactions() {
        if (this.rebalanceInterval) {
            clearInterval(this.rebalanceInterval);
        }
        const interval = Math.max(20, Math.floor(1000 / this.l1TPS));
        this.rebalanceInterval = setInterval(() => {
            if (this.isRunning) this.createRebalanceTransaction();
        }, interval);
    }

    findAvailableDepositorySpot() {
        // Randomly shuffle depositories
        const shuffledDepositories = [...this.depositories]
            .sort(() => Math.random() - 0.5);
        
        for (const depository of shuffledDepositories) {
            const takenSpots = this.depositorySpots.get(depository.id);
            if (takenSpots.size < 12) {  // Always check against 12 spots
                // Find first available spot
                for (let i = 0; i < 12; i++) {  // Check all 12 possible spots
                    if (!takenSpots.has(i)) {
                        return { depository, spotIndex: i };
                    }
                }
            }
        }
        return null;
    }

    getSpotPosition(spotIndex) {
        // Fill horizontally first (6 per row, 2 rows)
        const row = Math.floor(spotIndex / 6);  // 0 for first row, 1 for second row
        const col = spotIndex % 6;              // 0-5 for positions in each row
        return {
            x: -30 + (col * (this.onchainTxSize + 5)),  // 5px padding between transactions
            y: -15 + (row * (this.onchainTxSize + 5))   // 5px padding between rows
        };
    }

    createRebalanceTransaction() {
        const spot = this.findAvailableDepositorySpot();
        if (!spot) return;

        const { depository, spotIndex } = spot;
        
        // Only proceed if block isn't full
        if (this.depositorySpots.get(depository.id).size >= this.blockSize) {
            return;
        }
        
        // Check if spot is already taken
        if (this.depositorySpots.get(depository.id).has(spotIndex)) {
            return;
        }
        
        const source = this.hubs[Math.floor(Math.random() * this.hubs.length)];
        const position = this.getSpotPosition(spotIndex);
        const colors = this.colorSchemes[this.currentColorScheme];

        // Reserve spot before creating transaction
        this.depositorySpots.get(depository.id).add(spotIndex);
        
        const square = this.svg.append('rect')
            .attr('class', 'rebalance')
            .datum({ depositoryId: depository.id, spotIndex: spotIndex })
            .attr('x', source.x - this.onchainTxSize/2)
            .attr('y', source.y - this.onchainTxSize/2)
            .attr('width', this.onchainTxSize)
            .attr('height', this.onchainTxSize)
            .attr('fill', colors.onchainTx);

        square.transition()
            .duration(this.motionTime)
            .attr('x', depository.x + position.x)
            .attr('y', depository.y + position.y)
            .on('end', () => {
                depository.pendingTx++;
                
                // Check if block is exactly full
                if (this.depositorySpots.get(depository.id).size === this.blockSize) {
                    this.broadcastBlock(depository);
                }
            });
    }

    broadcastBlock(depository) {
        if (this.depositorySpots.get(depository.id).size !== 12) {
            return;
        }

        const currentCount = this.blockCounters.get(depository.id) || 0;
        this.blockCounters.set(depository.id, currentCount + 1);
        
        // Update counter first
        const counterText = this.svg.select(`.depository-${depository.id}-counter`);
        if (counterText.empty()) {
            this.svg.append('text')
                .attr('class', `depository-${depository.id}-counter`)
                .attr('x', depository.x)
                .attr('y', depository.y - 40)
                .attr('text-anchor', 'middle')
                .attr('fill', 'white')
                .attr('font-size', '16px')
                .text(`#${currentCount + 1}`);
        } else {
            counterText.text(`#${currentCount + 1}`);
        }

        // Create broadcast effect first
        switch(this.broadcastStyle) {
            case 'ripple':
                this.createRippleEffect(depository);
                break;
            case 'directed':
                this.createDirectedRipples(depository);
                break;
            case 'flash':
                this.createFlashEffect(depository);
                break;
            case 'rays':
                this.createRaysEffect(depository);
                break;
            case 'pulse':
                this.createPulseEffect(depository);
                break;
        }

        // Then remove transactions after a small delay
        setTimeout(() => {
            // Remove all transactions in this block
            this.svg.selectAll('.rebalance')
                .filter(d => d && d.depositoryId === depository.id)
                .remove();

            // Reset depository state
            depository.pendingTx = 0;
            this.depositorySpots.get(depository.id).clear();
        }, 50); // Small delay to ensure ripple starts first
    }

    createLegend() {
        const legend = this.svg.append('g')
            .attr('class', 'legend')
            .attr('transform', `translate(20, ${this.height - 150})`);

        const legendItems = [
            { label: 'User', type: 'circle', fill: '#2196F3', r: this.userRadius },
            { label: 'Hub', type: 'circle', fill: '#9C27B0', r: this.hubRadius },
            { label: 'Depository', type: 'rect', fill: '#444', width: 30, height: 20 },
            { label: 'L1 Transaction', type: 'rect', fill: '#FFD700', size: this.onchainTxSize },
            { label: 'L2 Transaction', type: 'circle', fill: '#FFF', r: this.dotRadius }
        ];

        const itemHeight = 25;
        legendItems.forEach((item, i) => {
            const g = legend.append('g')
                .attr('transform', `translate(0, ${i * itemHeight})`);

            if (item.type === 'circle') {
                g.append('circle')
                    .attr('r', item.r)
                    .attr('cx', 10)
                    .attr('cy', 10)
                    .attr('fill', item.fill);
            } else {
                g.append('rect')
                    .attr('width', item.width || item.size)
                    .attr('height', item.height || item.size)
                    .attr('x', item.width ? 0 : (10 - item.size/2))
                    .attr('y', item.height ? 0 : (10 - item.size/2))
                    .attr('fill', item.fill);
            }

            g.append('text')
                .attr('x', 30)
                .attr('y', 15)
                .attr('fill', 'white')
                .text(item.label);
        });

        // Add semi-transparent background
        const bbox = legend.node().getBBox();
        legend.insert('rect', ':first-child')
            .attr('x', -10)
            .attr('y', -10)
            .attr('width', bbox.width + 20)
            .attr('height', bbox.height + 20)
            .attr('fill', 'rgba(0, 0, 0, 0.7)')
            .attr('rx', 5);
    }

    createRippleEffect(depository) {
        const colors = this.colorSchemes[this.currentColorScheme];
        const maxDimension = Math.max(this.width, this.height) * 1.5;

        const ripple = this.svg.append('circle')
            .attr('cx', depository.x)
            .attr('cy', depository.y)
            .attr('r', 10)
            .attr('fill', 'none')
            .attr('stroke', colors.ripple)
            .attr('stroke-width', 2)
            .style('opacity', 1);

        ripple.transition()
            .duration(this.hubTime)
            .attr('r', maxDimension)
            .style('opacity', 0)
            .remove();
    }

    createDirectedRipples(depository) {
        const colors = this.colorSchemes[this.currentColorScheme];
        
        [...this.hubs, ...this.users].forEach(target => {
            const line = this.svg.append('line')
                .attr('x1', depository.x)
                .attr('y1', depository.y)
                .attr('x2', depository.x)
                .attr('y2', depository.y)
                .attr('stroke', colors.ripple)
                .attr('stroke-width', 2)
                .style('opacity', 1);

            line.transition()
                .duration(this.hubTime)
                .attr('x2', target.x)
                .attr('y2', target.y)
                .style('opacity', 0)
                .remove();
        });
    }

    createFlashEffect(depository) {
        const flash = this.svg.append('circle')
            .attr('cx', depository.x)
            .attr('cy', depository.y)
            .attr('r', 30)
            .attr('fill', '#FFD700')
            .style('opacity', 0.8);

        flash.transition()
            .duration(this.hubTime / 2)
            .style('opacity', 0)
            .remove();
    }

    createRaysEffect(depository) {
        const numRays = 8;
        const rayLength = 50;
        
        for (let i = 0; i < numRays; i++) {
            const angle = (2 * Math.PI * i) / numRays;
            const endX = depository.x + rayLength * Math.cos(angle);
            const endY = depository.y + rayLength * Math.sin(angle);
            
            const ray = this.svg.append('line')
                .attr('x1', depository.x)
                .attr('y1', depository.y)
                .attr('x2', depository.x)
                .attr('y2', depository.y)
                .attr('stroke', '#FFD700')
                .attr('stroke-width', 2);
            
            ray.transition()
                .duration(this.hubTime)
                .attr('x2', endX)
                .attr('y2', endY)
                .style('opacity', 0)
                .remove();
        }
    }

    createPulseEffect(depository) {
        const pulse = this.svg.append('circle')
            .attr('cx', depository.x)
            .attr('cy', depository.y)
            .attr('r', 20)
            .attr('fill', '#FFD700')
            .style('opacity', 0.5);

        pulse.transition()
            .duration(this.hubTime)
            .attr('r', 40)
            .style('opacity', 0)
            .remove();
    }
}

// Move initialization to DOMContentLoaded event
window.addEventListener('DOMContentLoaded', () => {
    new HubAndSpokeVisualization();
}); 