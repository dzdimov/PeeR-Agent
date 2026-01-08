document.addEventListener('DOMContentLoaded', async () => {
    try {
        const response = await fetch('/dashboard/api/stats');
        const data = await response.json();

        if (data.error) {
            console.error('Error fetching data:', data.error);
            return;
        }

        renderStats(data.stats);
        renderCharts(data.stats);
        renderTable(data.recent);
        
    } catch (error) {
        console.error('Failed to load dashboard data:', error);
    }
});

function renderStats(stats) {
    document.getElementById('stats-total-prs').textContent = stats.totalPRs;
    document.getElementById('stats-success-rate').textContent = `${stats.successRate.toFixed(1)}%`;
    document.getElementById('stats-avg-complexity').textContent = stats.avgComplexity.toFixed(1);
    
    // ROI Rendering
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(stats.roi.moneySaved);
    document.getElementById('stats-roi').textContent = `${stats.roi.hoursSaved.toFixed(0)}h (${money})`;

    // Render Recommendations
    const recList = document.getElementById('recommendations-list');
    recList.innerHTML = '';
    
    if (stats.commonRecommendations && stats.commonRecommendations.length > 0) {
        stats.commonRecommendations.forEach(item => {
            const div = document.createElement('div');
            div.className = 'flex items-start';
            div.innerHTML = `
                <span class="flex-shrink-0 h-6 w-6 flex items-center justify-center rounded-full bg-blue-100 text-blue-600 font-bold text-xs mr-3">
                    ${item.count}
                </span>
                <p class="text-sm text-gray-700">${item.text}</p>
            `;
            recList.appendChild(div);
        });
    } else {
        recList.innerHTML = '<p class="text-gray-500 italic">No recurring recommendations yet.</p>';
    }
}

function renderCharts(stats) {
    // Creators Chart
    const creatorsCtx = document.getElementById('chart-creators').getContext('2d');
    
    // Prepare data
    const labels = stats.perCreator.map(c => c.author);
    const counts = stats.perCreator.map(c => c.count);
    const complex = stats.perCreator.map(c => c.avg_complexity);

    new Chart(creatorsCtx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'PR Count',
                    data: counts,
                    backgroundColor: 'rgba(59, 130, 246, 0.5)',
                    borderColor: 'rgb(59, 130, 246)',
                    borderWidth: 1,
                    yAxisID: 'y'
                },
                {
                    label: 'Avg Complexity',
                    data: complex,
                    type: 'line',
                    borderColor: 'rgb(234, 179, 8)',
                    borderWidth: 2,
                    pointBackgroundColor: 'rgb(234, 179, 8)',
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Number of PRs' }
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    title: { display: true, text: 'Complexity (1-5)' },
                    min: 0,
                    max: 5,
                    grid: {
                        drawOnChartArea: false,
                    },
                }
            }
        }
    });

    // Trend Chart
    const trendCtx = document.getElementById('chart-trend').getContext('2d');
    
    const trendLabels = stats.qualityTrend.map(t => t.date);
    const trendData = stats.qualityTrend.map(t => t.avg_complexity);
    
    new Chart(trendCtx, {
        type: 'line',
        data: {
            labels: trendLabels,
            datasets: [{
                label: 'Avg Daily Complexity',
                data: trendData,
                borderColor: 'rgb(79, 70, 229)',
                backgroundColor: 'rgba(79, 70, 229, 0.1)',
                tension: 0.3,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    max: 5,
                    title: { display: true, text: 'Complexity Score' }
                }
            }
        }
    });

    // Complexity Chart
    const complexityCtx = document.getElementById('chart-complexity').getContext('2d');
    new Chart(complexityCtx, {
        type: 'doughnut',
        data: {
            labels: ['Low (1-2) - Good', 'Medium (3-4) - Watch', 'High (5) - Risky'],
            datasets: [{
                data: stats.complexityDistribution || [0, 0, 0],
                backgroundColor: [
                    'rgb(34, 197, 94)', // Green
                    'rgb(234, 179, 8)', // Yellow
                    'rgb(239, 68, 68)'  // Red
                ],
                borderWidth: 0
            }]
        },
        options: {
            cutout: '60%',
            plugins: {
                legend: {
                    position: 'bottom'
                }
            }
        }
    });
}

function renderTable(recent) {
    const tbody = document.getElementById('table-recent-body');
    tbody.innerHTML = '';

    recent.forEach(row => {
        const tr = document.createElement('tr');
        
        // Format Date
        const date = new Date(row.timestamp).toLocaleDateString();

        tr.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-blue-600">#${row.pr_number}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${row.repo_owner}/${row.repo_name}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">${row.author}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getComplexityColor(row.complexity)}">
                    ${row.complexity}/5
                </span>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${row.risks_count}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${date}</td>
        `;
        tbody.appendChild(tr);
    });
}

function getComplexityColor(score) {
    if (score < 3) return 'bg-green-100 text-green-800';
    if (score < 5) return 'bg-yellow-100 text-yellow-800';
    return 'bg-red-100 text-red-800';
}
