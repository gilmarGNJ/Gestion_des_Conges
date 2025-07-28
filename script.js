document.addEventListener('DOMContentLoaded', () => {
    const yearSelect = document.getElementById('year-select');
    const calendarDiv = document.getElementById('calendar');
    const summaryTableContainer = document.getElementById('summary-table-container');
    const prevYearButton = document.getElementById('prev-year');
    const nextYearButton = document.getElementById('next-year');
    const legendDiv = document.getElementById('legend');
    const saveDataButton = document.getElementById('save-data');
    const loadDataInput = document.getElementById('load-data-input');

    const years = [2024, 2025, 2026, 2027];
    const currentYear = new Date().getFullYear();

    const initialData = {
        2024: { CP: 14, RTTs: 11, JS: 1 },
        2025: { CP: 28, RTTs: 24, JS: 1 },
        2026: { CP: 28, RTTs: 24, JS: 1 },
        2027: { CP: 15, RTTs: 12.5, JS: 1 }
    };

    let holidayData = JSON.parse(localStorage.getItem('holidayData')) || {};

    function initialize() {
        populateYearSelect();
        yearSelect.value = years.includes(currentYear) ? currentYear : years[0];
        renderAll();
        addEventListeners();
    }

    function populateYearSelect() {
        years.forEach(year => {
            const option = document.createElement('option');
            option.value = year;
            option.textContent = year;
            yearSelect.appendChild(option);
        });
    }

    function renderAll() {
        renderSummaryTable();
        renderLegend();
        renderCalendar(parseInt(yearSelect.value));
    }

    function renderSummaryTable() {
        let table = `
            <table>
                <thead>
                    <tr>
                        <th>Année</th>
                        <th>CP Acquis</th>
                        <th>RTTs Acquis</th>
                        <th>RTTs Imposés</th>
                        <th>Journée Solidaire</th>
                        <th>CP Pris</th>
                        <th>RTTs Pris</th>
                        <th>CP Restants</th>
                        <th>RTTs Restants</th>
                    </tr>
                </thead>
                <tbody>
        `;

        for (const year of years) {
            const yearData = initialData[year];
            const cpTaken = countDays(year, 'conge-paye');
            const rttsTaken = countDays(year, 'rtt');
            const rttsHalfTaken = countDays(year, 'rtt-half');
            const totalRttsTaken = rttsTaken + (rttsHalfTaken * 0.5);
            const rttsImposes = countDays(year, 'rtt-impose');
            const js = yearData.JS;
            const rttsLeft = yearData.RTTs - totalRttsTaken - rttsImposes - js;
            const cpLeft = yearData.CP - cpTaken;

            table += `
                <tr>
                    <td>${year}</td>
                    <td class="acquis">${yearData.CP}</td>
                    <td class="acquis">${yearData.RTTs}</td>
                    <td class="pris">${rttsImposes}</td>
                    <td class="pris">${js}</td>
                    <td class="pris">${cpTaken}</td>
                    <td class="pris">${totalRttsTaken}</td>
                    <td class="restant">${cpLeft}</td>
                    <td class="restant">${rttsLeft}</td>
                </tr>
            `;
        }

        table += `</tbody></table>`;
        summaryTableContainer.innerHTML = table;
    }

    function renderLegend() {
        const legendItems = [
            { name: 'Congé Payé', class: 'conge-paye' },
            { name: 'RTT', class: 'rtt' },
            { name: 'RTT Imposé', class: 'rtt-impose' },
            { name: 'RTT 1/2', class: 'rtt-half' },
            { name: 'Jour Férié', class: 'holiday' }
        ];

        legendDiv.innerHTML = legendItems.map(item => `
            <div class="legend-item">
                <div class="legend-color ${item.class}"></div>
                <span>${item.name}</span>
            </div>
        `).join('');
    }

    function renderCalendar(year) {
        calendarDiv.innerHTML = '';
        const monthNames = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
        const dayNames = ["Di", "Lu", "Ma", "Me", "Je", "Ve", "Sa"];

        for (let month = 0; month < 12; month++) {
            const monthDiv = document.createElement('div');
            monthDiv.className = 'month';

            const monthNameDiv = document.createElement('div');
            monthNameDiv.className = 'month-name';
            monthNameDiv.textContent = monthNames[month];
            monthDiv.appendChild(monthNameDiv);

            const daysDiv = document.createElement('div');
            daysDiv.className = 'days';

            dayNames.forEach(name => {
                const dayNameDiv = document.createElement('div');
                dayNameDiv.className = 'day-name';
                dayNameDiv.textContent = name;
                daysDiv.appendChild(dayNameDiv);
            });

            const date = new Date(year, month, 1);
            const firstDay = date.getDay();
            const daysInMonth = new Date(year, month + 1, 0).getDate();

            for (let i = 0; i < firstDay; i++) {
                daysDiv.appendChild(document.createElement('div'));
            }

            for (let day = 1; day <= daysInMonth; day++) {
                const dayDiv = document.createElement('div');
                dayDiv.className = 'day';
                dayDiv.textContent = day;
                const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                dayDiv.dataset.date = dateStr;

                if (holidayData[dateStr]) {
                    dayDiv.classList.add(holidayData[dateStr]);
                }

                const currentDate = new Date(year, month, day);
                const dayOfWeek = currentDate.getDay();

                if (dayOfWeek === 0 || dayOfWeek === 6) { // Sunday or Saturday
                    dayDiv.classList.add('weekend');
                } else {
                    dayDiv.addEventListener('click', handleDayClick);
                }

                daysDiv.appendChild(dayDiv);
            }

            monthDiv.appendChild(daysDiv);
            calendarDiv.appendChild(monthDiv);
        }
    }

    function handleDayClick(event) {
        const date = event.target.dataset.date;
        if (!date) return;

        const currentStatus = holidayData[date];
        let nextStatus;

        switch (currentStatus) {
            case 'conge-paye':
                nextStatus = 'rtt';
                break;
            case 'rtt':
                nextStatus = 'rtt-impose';
                break;
            case 'rtt-impose':
                nextStatus = 'rtt-half';
                break;
            case 'rtt-half':
                nextStatus = 'holiday';
                break;
            case 'holiday':
                delete holidayData[date];
                nextStatus = null;
                break;
            default:
                nextStatus = 'conge-paye';
                break;
        }

        if (nextStatus) {
            holidayData[date] = nextStatus;
        }

        localStorage.setItem('holidayData', JSON.stringify(holidayData));
        renderAll();
    }

    function saveData() {
        // Note: Browser security prevents specifying a save path.
        // The file will be saved to the user's default "Downloads" folder.
        const dataStr = JSON.stringify(holidayData, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'holidays-data.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function loadData(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (typeof data === 'object' && data !== null) {
                    holidayData = data;
                    localStorage.setItem('holidayData', JSON.stringify(holidayData));
                    renderAll();
                    alert('Données chargées avec succès !');
                } else {
                    alert('Fichier JSON invalide.');
                }
            } catch (error) {
                alert('Erreur lors de la lecture du fichier : ' + error.message);
            }
        };
        reader.readAsText(file);
        event.target.value = null; // Reset input to allow loading same file again
    }

    function countDays(year, type) {
        return Object.keys(holidayData).filter(date => date.startsWith(year) && holidayData[date] === type).length;
    }

    function addEventListeners() {
        yearSelect.addEventListener('change', () => {
            renderCalendar(parseInt(yearSelect.value));
        });

        prevYearButton.addEventListener('click', () => {
            const current = parseInt(yearSelect.value);
            const newYear = Math.max(current - 1, years[0]);
            yearSelect.value = newYear;
            renderCalendar(newYear);
        });

        nextYearButton.addEventListener('click', () => {
            const current = parseInt(yearSelect.value);
            const newYear = Math.min(current + 1, years[years.length - 1]);
            yearSelect.value = newYear;
            renderCalendar(newYear);
        });

        saveDataButton.addEventListener('click', saveData);
        loadDataInput.addEventListener('change', loadData);
    }

    initialize();
});
