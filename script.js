import ptBR from "https://cdn.jsdelivr.net/npm/date-fns/esm/locale/pt-BR/index.js";
        
// --- Importações do Firebase ---
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { 
    getAuth, 
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { 
    getFirestore, 
    collection, 
    doc, 
    getDocs, 
    setDoc,
    addDoc,
    deleteDoc,
    onSnapshot,
    query
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";


document.addEventListener('DOMContentLoaded', () => {
    // --- Variáveis Globais de Firebase ---
    let auth, db;
    let unsubscribeRoutines, unsubscribeWorkouts, unsubscribeGoals; // Para limpar os listeners

    // --- ESTADO GLOBAL DA APLICAÇÃO ---
    const state = {
        userId: null,
        routines: [], workouts: [], goals: [], currentWorkout: null, charts: {}
    };

    // --- ELEMENTOS DO DOM ---
    const authContainer = document.getElementById('auth-container');
    const appContainer = document.getElementById('app-container');
    const loginForm = document.getElementById('login-form');
    const signupForm = document.getElementById('signup-form');

    const pageElements = {
        dashboard: document.getElementById('page-dashboard'),
        logWorkout: document.getElementById('page-log-workout'),
        history: document.getElementById('page-history'),
        analytics: document.getElementById('page-analytics'),
        goals: document.getElementById('page-goals'),
        settings: document.getElementById('page-settings'),
    };

    const modalElements = {
        toast: document.getElementById('toast'),
        ai: document.getElementById('ai-modal'),
        edit: document.getElementById('edit-modal'),
        confirm: document.getElementById('confirm-modal'),
        feedback: document.getElementById('workout-feedback-modal'),
        details: document.getElementById('workout-details-modal'),
    };
    
    // --- LÓGICA DA API GEMINI ---
    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=`;
    const callGeminiAPI = async (systemPrompt, userPrompt) => {
         const apiKey = ""; // Será fornecido pelo ambiente.
        try {
            const payload = {
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: [{ parts: [{ text: userPrompt }] }]
            };
            const response = await fetch(GEMINI_API_URL + apiKey, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) throw new Error(`API Error: ${response.statusText}`);

            const result = await response.json();
            return result.candidates[0].content.parts[0].text;
        } catch (error) {
            console.error("Erro ao chamar a API Gemini:", error);
            modal.toast("Falha ao comunicar com a IA. Tente novamente.", false);
            return null;
        }
    };

    // --- TEMPLATES HTML ---
    const templates = {
        pageTitle: (title, subtitle) => `<div class="mb-8"><h1 class="text-3xl font-bold text-white">${title}</h1><p class="text-gray-400 mt-1">${subtitle}</p></div>`,
        modal: (id, title, body, footer) => `
            <div class="modal-backdrop fixed inset-0" onclick="window.modal.hide('${id}')"></div>
            <div class="modal-content bg-gray-800 rounded-lg shadow-xl p-6 w-11/12 md:w-1/2 lg:w-1/3 overflow-y-auto">
                <div class="flex justify-between items-center mb-4 border-b border-gray-700 pb-3">
                    <h3 class="text-xl font-bold text-white">${title}</h3>
                    <button onclick="window.modal.hide('${id}')" class="text-gray-400 hover:text-white"><i data-lucide="x"></i></button>
                </div>
                <div class="modal-body">${body}</div>
                ${footer ? `<div class="modal-footer mt-6 flex justify-end gap-3">${footer}</div>` : ''}
            </div>`,
        spinner: (text) => `<div class="flex flex-col items-center justify-center min-h-[150px]"><div class="spinner w-8 h-8 rounded-full border-4"></div><p class="mt-4 text-gray-400">${text}</p></div>`,
        statCard: (icon, label, value, subtext) => `
            <div class="bg-gray-800/50 p-6 rounded-xl border border-gray-700">
                <div class="flex items-center gap-4">
                    <div class="bg-gray-700 p-3 rounded-lg"><i data-lucide="${icon}" class="text-blue-400"></i></div>
                    <div>
                        <p class="text-gray-400 text-sm">${label}</p>
                        <p class="text-2xl font-bold text-white">${value}</p>
                    </div>
                </div>
                ${subtext ? `<p class="text-xs text-gray-500 mt-3">${subtext}</p>`: ''}
            </div>`,
    };
    
    // --- LÓGICA DE NEGÓCIO (CÁLCULOS) ---
    const logic = {
        formatDate: (dateStr, options = { year: 'numeric', month: 'long', day: 'numeric' }) => {
            return new Date(dateStr).toLocaleDateString('pt-BR', options);
        },
        getPRs: (exerciseName = null) => {
            const prs = {};
            state.workouts.forEach(workout => {
                if (!workout.exercises) return;
                workout.exercises.forEach(ex => {
                    if (!ex || !ex.name || !ex.sets) return;
                    ex.sets.forEach(set => {
                        if (!prs[ex.name] || set.weight > prs[ex.name].weight) {
                            prs[ex.name] = { weight: set.weight, reps: set.reps, date: workout.date };
                        }
                    });
                });
            });
            if (exerciseName) return prs[exerciseName] || { weight: 0, reps: 0 };
            return Object.entries(prs).sort(([,a],[,b]) => b.weight - a.weight);
        },
        getWeeklyVolume: () => {
            const oneWeekAgo = new Date();
            oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
            return state.workouts
                .filter(w => new Date(w.date) > oneWeekAgo)
                .reduce((total, workout) => total + logic.calculateWorkoutVolume(workout), 0);
        },
        calculateWorkoutVolume: (workout) => {
            if (!workout || !workout.exercises) return 0;
            return workout.exercises.reduce((workoutVol, ex) => 
                workoutVol + ex.sets.reduce((exVol, set) => exVol + (set.weight * set.reps), 0)
            , 0);
        },
        checkForStagnation: () => {
            const stagnantExercises = [];
            const allExerciseNames = [...new Set(state.workouts.flatMap(w => w.exercises.map(e => e.name)))];

            allExerciseNames.forEach(name => {
                const history = state.workouts
                    .map(w => ({ date: w.date, ex: w.exercises.find(e => e.name === name) }))
                    .filter(data => data.ex && data.ex.sets.length > 0)
                    .map(data => ({ date: data.date, maxWeight: Math.max(...data.ex.sets.map(s => s.weight)) }))
                    .slice(-3); // Pega os últimos 3 treinos para este exercício

                if (history.length === 3 && history[0].maxWeight >= history[1].maxWeight && history[1].maxWeight >= history[2].maxWeight) {
                    stagnantExercises.push({ name, weight: history[2].maxWeight });
                }
            });
            return stagnantExercises;
        }
    };

    // --- RENDERIZAÇÃO DAS PÁGINAS ---
    const renderPage = {
        dashboard: () => {
            const el = pageElements.dashboard;
            const lastWorkout = state.workouts.length > 0 ? [...state.workouts].sort((a,b) => new Date(b.date) - new Date(a.date))[0] : null;
            const prs = logic.getPRs();
            const weeklyVolume = logic.getWeeklyVolume();
            const stagnation = logic.checkForStagnation();

            let lastWorkoutHTML = `
                <div class="bg-gray-800/50 p-6 rounded-xl border border-gray-700 col-span-1 md:col-span-2 lg:col-span-1">
                   <h3 class="font-semibold text-white mb-3">Último Treino</h3>`;
            if (lastWorkout) {
                lastWorkoutHTML += `
                    <p class="font-bold text-lg text-blue-400">${lastWorkout.routineName}</p>
                    <p class="text-sm text-gray-400 mb-2">${logic.formatDate(lastWorkout.date)}</p>
                    <p class="text-sm text-gray-300">${logic.calculateWorkoutVolume(lastWorkout).toFixed(0)} kg de volume total</p>
                `;
            } else {
                lastWorkoutHTML += `<p class="text-gray-400">Nenhum treino registrado.</p>`;
            }
            lastWorkoutHTML += `</div>`;

            let stagnationHTML = '';
            if (stagnation.length > 0) {
                stagnationHTML = `
                <div class="bg-yellow-900/30 p-6 rounded-xl border border-yellow-700 md:col-span-2 lg:col-span-3">
                    <h3 class="font-semibold text-yellow-300 mb-3 flex items-center"><i data-lucide="alert-triangle" class="mr-2"></i> Alerta de Estagnação</h3>
                    <p class="text-sm text-yellow-400">Você parece estar estagnado nos seguintes exercícios. Considere variar o treino ou fazer um deload.</p>
                    <ul class="mt-2 text-sm list-disc list-inside text-yellow-300">
                        ${stagnation.map(s => `<li>${s.name} (${s.weight} kg)</li>`).join('')}
                    </ul>
                </div>`;
            }

            el.innerHTML = templates.pageTitle('Painel', `Olá! Aqui está seu resumo fitness.`) + `
                <div class="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                   ${stagnationHTML}
                   ${lastWorkoutHTML}
                   ${templates.statCard('bar-chart', 'Treinos Totais', state.workouts.length, 'Sessões registradas')}
                   ${templates.statCard('trending-up', 'Volume Semanal', `${weeklyVolume.toFixed(0)} kg`, 'Carga total nos últimos 7 dias')}
                   <div class="bg-gray-800/50 p-6 rounded-xl border border-gray-700 md:col-span-2">
                        <h3 class="font-semibold text-white mb-3">Recordes Pessoais (PRs)</h3>
                        <ul class="space-y-2">
                        ${prs.length > 0 ? prs.slice(0, 5).map(([name, data]) => `
                            <li class="flex justify-between items-center text-sm">
                                <span class="text-gray-300">${name}</span>
                                <span class="font-bold text-white bg-gray-700 px-2 py-1 rounded">${data.weight} kg x ${data.reps} reps</span>
                            </li>`).join('') : '<li class="text-gray-400">Registre treinos para ver seus recordes.</li>'}
                        </ul>
                   </div>
                   <div class="bg-gray-800/50 p-6 rounded-xl border border-gray-700 flex flex-col justify-center items-center">
                       <h3 class="font-semibold text-white mb-3">Análise com IA</h3>
                       <p class="text-gray-400 text-sm text-center mb-4">Receba insights sobre seu progresso nos últimos 30 dias.</p>
                       <button onclick="app.analyzeProgress()" class="bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded-lg flex items-center gap-2 transition duration-300">
                            <i data-lucide="sparkles" class="w-5 h-5"></i> Analisar Progresso
                        </button>
                   </div>
                </div>`;
        },
        logWorkout: () => {
            const el = pageElements.logWorkout;
            let content;
            if (state.currentWorkout) {
                content = templates.pageTitle(state.currentWorkout.routineName, `Iniciado em ${logic.formatDate(state.currentWorkout.date, {hour: '2-digit', minute: '2-digit'})}`);
                content += `<div id="current-workout-area" class="mt-6 space-y-6"></div>
                <div class="mt-8 flex gap-4">
                    <button onclick="app.finishWorkout()" class="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-6 rounded-lg transition duration-300">Finalizar Treino</button>
                    <button onclick="app.cancelWorkout()" class="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-6 rounded-lg transition duration-300">Cancelar</button>
                </div>`;
                
            } else {
                content = templates.pageTitle('Registrar Treino', 'Escolha uma rotina para começar.');
                content += '<div class="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">';
                state.routines.forEach((routine) => {
                    content += `<button onclick="app.startWorkout('${routine.id}')" class="text-left bg-gray-800/50 p-6 rounded-xl border border-gray-700 hover:border-blue-500 transition-all">
                        <h3 class="font-semibold text-white">${routine.name}</h3>
                        <p class="text-gray-400 text-sm mt-1">${routine.exercises.length} exercícios</p>
                    </button>`;
                });
                content += '</div>';
            }
            el.innerHTML = content;
            if(state.currentWorkout) renderPage.renderCurrentWorkout();
        },
        renderCurrentWorkout: () => {
            const area = document.getElementById('current-workout-area');
            if(!area) return;
            area.innerHTML = state.currentWorkout.exercises.map((ex, exIndex) => `
                <div class="bg-gray-800/50 p-4 rounded-xl border border-gray-700">
                    <h4 class="font-bold text-lg mb-3">${ex.name}</h4>
                    <div class="space-y-2 mb-3">
                        ${ex.sets.map((set, setIndex) => `
                            <div class="flex items-center justify-between bg-gray-700 p-2 rounded">
                                <span class="text-sm">Série ${setIndex + 1}: <span class="font-bold">${set.weight} kg</span> x <span class="font-bold">${set.reps} reps</span></span>
                                <button class="text-red-400 hover:text-red-300" onclick="app.removeSet(${exIndex}, ${setIndex})"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                            </div>
                        `).join('')}
                    </div>
                    <div class="flex gap-2">
                        <input type="number" placeholder="Carga (kg)" class="w-full bg-gray-700 border border-gray-600 rounded p-2 focus:outline-none" id="weight-input-${exIndex}">
                        <input type="number" placeholder="Reps" class="w-full bg-gray-700 border border-gray-600 rounded p-2 focus:outline-none" id="reps-input-${exIndex}">
                        <button class="bg-blue-600 hover:bg-blue-700 text-white font-bold p-2 rounded" onclick="app.addSet(${exIndex})">Adicionar</button>
                    </div>
                </div>
            `).join('');
            lucide.createIcons();
        },
        history: () => {
             const el = pageElements.history;
             let content = templates.pageTitle('Histórico de Treinos', 'Veja todos os seus treinos registrados.');
             if (state.workouts.length > 0) {
                content += `<div class="mt-8 space-y-4">`;
                [...state.workouts].sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(workout => {
                    content += `
                    <div class="bg-gray-800/50 p-4 rounded-xl border border-gray-700 flex justify-between items-center">
                        <div>
                            <p class="font-bold text-white">${workout.routineName}</p>
                            <p class="text-sm text-gray-400">${logic.formatDate(workout.date)}</p>
                        </div>
                        <div class="flex items-center gap-2">
                            <button class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg" onclick="window.modal.showWorkoutDetails('${workout.id}')">Ver Detalhes</button>
                            <button class="text-red-400 hover:text-red-300 p-2 rounded-lg bg-gray-700 hover:bg-red-900/50" onclick="app.deleteWorkout('${workout.id}')"><i data-lucide="trash-2"></i></button>
                        </div>
                    </div>`;
                });
                content += `</div>`;
             } else {
                content += `<div class="mt-8 bg-gray-800/50 p-6 rounded-xl border border-gray-700"><p class="text-gray-400">Nenhum treino registrado ainda. Vá para a aba 'Registrar' para começar!</p></div>`;
             }
             el.innerHTML = content;
        },
        analytics: () => {
             const el = pageElements.analytics;
             const allExercises = [...new Set(state.workouts.flatMap(w => w.exercises ? w.exercises.map(e => e ? e.name : null) : []).filter(Boolean))];
             let content = templates.pageTitle('Análises', 'Mergulhe nos seus dados de performance.');
             if (allExercises.length > 0) {
                 content += `
                 <div class="bg-gray-800/50 p-6 rounded-xl border border-gray-700">
                     <div class="mb-6">
                         <label for="exercise-analytics-select" class="block mb-2 font-bold">Selecione um Exercício:</label>
                         <select id="exercise-analytics-select" onchange="app.renderChart(this.value)" class="w-full bg-gray-700 border border-gray-600 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-500">
                             ${allExercises.map(name => `<option value="${name}">${name}</option>`).join('')}
                         </select>
                     </div>
                     <div class="h-96"><canvas id="progress-chart"></canvas></div>
                 </div>`;
             } else {
                 content += `<div class="mt-8 bg-gray-800/50 p-6 rounded-xl border border-gray-700"><p class="text-gray-400">Registre alguns treinos para ver suas análises.</p></div>`;
             }
             el.innerHTML = content;
             if (allExercises.length > 0) app.renderChart(allExercises[0]);
        },
        goals: () => {
            const el = pageElements.goals;
            let content = templates.pageTitle('Minhas Metas', 'Defina e acompanhe seus objetivos.');
            
            content += `
                <div class="mb-6 text-right">
                     <button onclick="window.modal.showAddGoal()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg flex items-center gap-2 transition duration-300 inline-flex">
                        <i data-lucide="plus" class="w-5 h-5"></i> Nova Meta
                    </button>
                </div>`;

            if (state.goals.length > 0) {
                content += `<div class="space-y-6">`;
                state.goals.forEach(goal => {
                    const progress = goal.targetWeight > goal.startingWeight ? Math.min(100, Math.max(0, ((goal.currentWeight - goal.startingWeight) / (goal.targetWeight - goal.startingWeight)) * 100)) : 0;
                    const daysLeft = Math.ceil((new Date(goal.targetDate) - new Date()) / (1000 * 60 * 60 * 24));

                    content += `
                    <div class="bg-gray-800/50 p-6 rounded-xl border border-gray-700">
                        <div class="flex justify-between items-start">
                            <div>
                                <p class="font-bold text-lg text-white">${goal.exerciseName}</p>
                                <p class="text-2xl font-bold text-blue-400">${goal.targetWeight} kg</p>
                            </div>
                            <button class="text-red-400 hover:text-red-300" onclick="app.deleteGoal('${goal.id}')"><i data-lucide="trash-2"></i></button>
                        </div>
                        <div class="mt-4">
                            <div class="flex justify-between text-sm mb-1">
                                <span class="text-gray-400">Progresso</span>
                                <span class="font-bold text-white">${progress.toFixed(0)}%</span>
                            </div>
                            <div class="progress-bar-container w-full h-3">
                                <div class="progress-bar h-3" style="width: ${progress}%;"></div>
                            </div>
                            <div class="flex justify-between text-xs text-gray-500 mt-1">
                                <span>Início: ${goal.startingWeight} kg</span>
                                <span>Atual: ${goal.currentWeight} kg</span>
                            </div>
                        </div>
                        <div class="mt-4 text-sm text-gray-400">
                            <p>Restam ${daysLeft >= 0 ? daysLeft : 0} dias (Alvo: ${logic.formatDate(goal.targetDate)})</p>
                        </div>
                    </div>`;
                });
                content += `</div>`;
            } else {
                content += `<div class="bg-gray-800/50 p-6 rounded-xl border border-gray-700"><p class="text-gray-400 text-center">Você ainda não definiu nenhuma meta. Clique em "Nova Meta" para começar!</p></div>`;
            }
             el.innerHTML = content;
        },
        settings: () => {
             const el = pageElements.settings;
             el.innerHTML = templates.pageTitle('Rotinas e Exercícios', 'Gerencie seus treinos.') + `
                <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div class="bg-gray-800/50 p-6 rounded-xl border border-gray-700">
                        <h3 class="font-bold text-lg mb-4">Minhas Rotinas</h3>
                        <div class="flex gap-2 mb-4">
                            <input type="text" id="new-routine-name" placeholder="Nome da Nova Rotina" class="flex-1 bg-gray-700 border border-gray-600 rounded-lg p-2 focus:outline-none">
                            <button onclick="app.addRoutine()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold p-2 rounded-lg"><i data-lucide="plus"></i></button>
                        </div>
                        <ul id="routines-list" class="space-y-2"></ul>
                    </div>
                    <div class="bg-gray-800/50 p-6 rounded-xl border border-gray-700">
                        <h3 class="font-bold text-lg mb-4">Gerenciar Exercícios da Rotina</h3>
                        <div id="exercise-manager-area"></div>
                    </div>
                </div>`;
             renderPage.renderRoutinesList();
             renderPage.renderExerciseManager();
        },
        renderRoutinesList: () => {
            const list = document.getElementById('routines-list');
            if(!list) return;
            list.innerHTML = state.routines.map((routine) => `
                <li class="flex justify-between items-center bg-gray-700 p-2 rounded">
                    <span>${routine.name}</span>
                    <div class="flex items-center gap-2">
                        <button class="text-blue-400 hover:text-blue-300" onclick="app.editRoutine('${routine.id}')"><i data-lucide="pencil" class="w-4 h-4"></i></button>
                        <button class="text-red-400 hover:text-red-300" onclick="app.deleteRoutine('${routine.id}')"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                    </div>
                </li>
            `).join('');
            lucide.createIcons();
        },
        renderExerciseManager: (selectedIndex = 0) => {
            const area = document.getElementById('exercise-manager-area');
            if(!area) return;
            if(state.routines.length === 0) {
                area.innerHTML = `<p class="text-gray-400">Crie uma rotina primeiro para poder adicionar exercícios.</p>`;
                return;
            }
            const routineId = state.routines[selectedIndex].id;
            area.innerHTML = `
                <div class="mb-4">
                    <label for="manage-routine-select" class="block mb-2">Selecione a Rotina:</label>
                    <select id="manage-routine-select" onchange="renderPage.renderExerciseManager(this.selectedIndex)" class="w-full bg-gray-700 border border-gray-600 rounded-lg p-2 focus:outline-none">
                        ${state.routines.map((r, i) => `<option value="${r.id}" ${i == selectedIndex ? 'selected' : ''}>${r.name}</option>`).join('')}
                    </select>
                </div>
                <div class="flex gap-2 mb-4">
                    <input type="text" id="new-exercise-name" placeholder="Nome do Exercício" class="flex-1 bg-gray-700 border border-gray-600 rounded-lg p-2 focus:outline-none">
                    <input type="text" id="new-exercise-muscle" placeholder="Grupo Muscular" class="flex-1 bg-gray-700 border border-gray-600 rounded-lg p-2 focus:outline-none">
                    <button onclick="app.addExercise()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold p-2 rounded-lg"><i data-lucide="plus"></i></button>
                </div>
                <h4 class="font-bold mt-6 mb-2">Exercícios na Rotina:</h4>
                <ul id="exercise-list" class="space-y-2"></ul>`;
            renderPage.renderExerciseList(routineId);
        },
        renderExerciseList: (routineId) => {
            const list = document.getElementById('exercise-list');
            if(!list) return;
            const routine = state.routines.find(r => r.id === routineId);
            if (routine && routine.exercises) {
                 list.innerHTML = routine.exercises.map((ex, exIndex) => `
                    <li class="flex justify-between items-center bg-gray-700 p-2 rounded">
                        <div>
                            <span>${ex.name}</span>
                            <span class="text-xs bg-gray-600 px-2 py-1 rounded-full ml-2">${ex.muscle}</span>
                        </div>
                        <div class="flex items-center gap-3">
                            <button class="text-blue-400 hover:text-blue-300" onclick="app.editExercise('${routineId}', ${exIndex})"><i data-lucide="pencil" class="w-4 h-4"></i></button>
                            <button class="text-red-400 hover:text-red-300" onclick="app.removeExercise('${routineId}', ${exIndex})"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                        </div>
                    </li>
                `).join('');
                lucide.createIcons();
            } else {
                list.innerHTML = `<li class="text-gray-400">Nenhum exercício nesta rotina.</li>`;
            }
        },
    };
    
    // --- LÓGICA DOS MODAIS (AGORA NO OBJETO GLOBAL 'window.modal') ---
    window.modal = {
        toast: (message, isSuccess = true) => {
            const el = modalElements.toast;
            el.textContent = message;
            el.className = `fixed bottom-5 right-5 text-white py-2 px-4 rounded-lg shadow-lg transform transition-all duration-300 ${isSuccess ? 'bg-green-500' : 'bg-red-500'}`;
            el.classList.remove('translate-y-20', 'opacity-0');
            setTimeout(() => el.classList.add('translate-y-20', 'opacity-0'), 3000);
        },
        show: (id, title, body, footer) => {
            modalElements[id].innerHTML = templates.modal(id, title, body, footer);
            modalElements[id].classList.remove('hidden');
            lucide.createIcons();
        },
        hide: (id) => {
            modalElements[id].classList.add('hidden');
            modalElements[id].innerHTML = '';
        },
        showEdit: (title, currentValue, onSave) => {
            const body = `<input type="text" id="edit-modal-input" class="w-full bg-gray-700 border border-gray-600 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-blue-500" value="${currentValue}">`;
            const footer = `<button class="bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded-lg" onclick="window.modal.hide('edit')">Cancelar</button>
                          <button id="edit-modal-save-btn" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg">Salvar</button>`;
            window.modal.show('edit', title, body, footer);
            const saveBtn = document.getElementById('edit-modal-save-btn');
            const input = document.getElementById('edit-modal-input');
            input.focus();
            input.select();
            saveBtn.onclick = () => onSave(input.value);
        },
        showEditExercise: (exercise, onSave) => {
            const body = `
                <div class="space-y-4">
                    <div>
                        <label for="edit-exercise-name" class="block mb-1 text-sm">Nome do Exercício</label>
                        <input type="text" id="edit-exercise-name" class="w-full bg-gray-700 p-2 rounded border border-gray-600" value="${exercise.name}">
                    </div>
                    <div>
                        <label for="edit-exercise-muscle" class="block mb-1 text-sm">Grupo Muscular</label>
                        <input type="text" id="edit-exercise-muscle" class="w-full bg-gray-700 p-2 rounded border border-gray-600" value="${exercise.muscle}">
                    </div>
                </div>`;
            const footer = `<button class="bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded-lg" onclick="window.modal.hide('edit')">Cancelar</button>
                          <button id="edit-exercise-save-btn" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg">Salvar</button>`;
            window.modal.show('edit', 'Editar Exercício', body, footer);
            
            document.getElementById('edit-exercise-save-btn').onclick = () => {
                const newName = document.getElementById('edit-exercise-name').value.trim();
                const newMuscle = document.getElementById('edit-exercise-muscle').value.trim() || 'Geral';
                onSave(newName, newMuscle);
            };
        },
         showConfirm: (title, message, onConfirm) => {
            const footer = `<button class="bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded-lg" onclick="window.modal.hide('confirm')">Cancelar</button>
                          <button id="confirm-modal-confirm-btn" class="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg">Confirmar</button>`;
            window.modal.show('confirm', title, message, footer);
            document.getElementById('confirm-modal-confirm-btn').onclick = () => {
                onConfirm();
                window.modal.hide('confirm');
            };
        },
        showWorkoutDetails: (workoutId) => {
            const workout = state.workouts.find(w => w.id == workoutId);
            if(!workout) return;
            
            let feedbackHTML = '<div class="mt-4 border-t border-gray-700 pt-4"><h4 class="font-bold text-white mb-2">Feedback do Treino</h4>';
            if (workout.feedback && Object.keys(workout.feedback).length > 0) {
                feedbackHTML += `
                    <div class="grid grid-cols-3 gap-2 text-center text-sm mb-2">
                        <span>Energia: ${'★'.repeat(workout.feedback.energy)}${'☆'.repeat(5-workout.feedback.energy)}</span>
                        <span>Humor: ${'★'.repeat(workout.feedback.mood)}${'☆'.repeat(5-workout.feedback.mood)}</span>
                        <span>Motivação: ${'★'.repeat(workout.feedback.motivation)}${'☆'.repeat(5-workout.feedback.motivation)}</span>
                    </div>
                    ${workout.feedback.notes ? `<p class="text-sm text-gray-300 bg-gray-700 p-2 rounded"><strong>Notas:</strong> ${workout.feedback.notes}</p>` : ''}
                `;
            } else {
                feedbackHTML += `<p class="text-sm text-gray-400">Nenhum feedback registrado.</p>`;
            }
            feedbackHTML += `</div>`;

            let body = `<p class="text-sm text-gray-400 mb-4">Volume total: <strong>${logic.calculateWorkoutVolume(workout).toFixed(0)} kg</strong></p>
                        <ul class="space-y-4">`;
            workout.exercises.forEach(ex => {
                 if(ex.sets.length > 0) {
                    body += `<li>
                        <p class="font-bold text-white">${ex.name}</p>
                        <ul class="text-sm text-gray-300 pl-4 space-y-1 mt-1">
                            ${ex.sets.map((set, i) => `<li>Série ${i+1}: ${set.weight} kg x ${set.reps} reps</li>`).join('')}
                        </ul>
                    </li>`;
                 }
            });
            body += `</ul>${feedbackHTML}`;
            window.modal.show('details', workout.routineName, body);
        },
        showFeedback: (onSave) => {
            const starRating = (name, label) => `
                <div class="flex flex-col items-center">
                    <label class="mb-1 text-sm text-gray-300">${label}</label>
                    <div class="rating-stars text-3xl">
                        <input type="radio" id="${name}-5" name="${name}" value="5"><label for="${name}-5">★</label>
                        <input type="radio" id="${name}-4" name="${name}" value="4"><label for="${name}-4">★</label>
                        <input type="radio" id="${name}-3" name="${name}" value="3" checked><label for="${name}-3">★</label>
                        <input type="radio" id="${name}-2" name="${name}" value="2"><label for="${name}-2">★</label>
                        <input type="radio" id="${name}-1" name="${name}" value="1"><label for="${name}-1">★</label>
                    </div>
                </div>`;

            const body = `
                <div class="grid grid-cols-3 gap-4 mb-4">
                   ${starRating('energy', 'Energia')}
                   ${starRating('mood', 'Humor')}
                   ${starRating('motivation', 'Motivação')}
                </div>
                <div>
                   <label for="feedback-notes" class="block mb-2 text-sm text-gray-300">Notas sobre dores, fadiga, etc:</label>
                   <textarea id="feedback-notes" rows="3" class="w-full bg-gray-700 border border-gray-600 rounded-lg p-2 focus:outline-none"></textarea>
                </div>`;

            const footer = `<button id="save-feedback-btn" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg">Salvar Feedback</button>`;
            window.modal.show('feedback', 'Feedback Pós-Treino', body, footer);
            document.getElementById('save-feedback-btn').onclick = () => {
                const feedback = {
                    energy: document.querySelector('input[name="energy"]:checked').value,
                    mood: document.querySelector('input[name="mood"]:checked').value,
                    motivation: document.querySelector('input[name="motivation"]:checked').value,
                    notes: document.getElementById('feedback-notes').value,
                };
                onSave(feedback);
            };
        },
        showAddGoal: () => {
            const allExercises = [...new Set(state.workouts.flatMap(w => w.exercises ? w.exercises.map(e => e ? e.name : null) : []).filter(Boolean))];
            if (allExercises.length === 0) {
                window.modal.toast("Você precisa registrar um treino antes de criar uma meta.", false);
                return;
            }
            const body = `
                <div class="space-y-4">
                    <div>
                        <label for="goal-exercise" class="block mb-1 text-sm">Exercício</label>
                        <select id="goal-exercise" class="w-full bg-gray-700 p-2 rounded border border-gray-600">
                            ${allExercises.map(ex => `<option value="${ex}">${ex}</option>`).join('')}
                        </select>
                    </div>
                     <div>
                        <label for="goal-weight" class="block mb-1 text-sm">Carga Alvo (kg)</label>
                        <input type="number" id="goal-weight" class="w-full bg-gray-700 p-2 rounded border border-gray-600">
                    </div>
                    <div>
                        <label for="goal-date" class="block mb-1 text-sm">Data Alvo</label>
                        <input type="date" id="goal-date" class="w-full bg-gray-700 p-2 rounded border border-gray-600">
                    </div>
                </div>`;
            const footer = `<button class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg" onclick="app.addGoal()">Criar Meta</button>`;
            window.modal.show('edit', 'Criar Nova Meta', body, footer);
        }
    };

    // --- LÓGICA DE NAVEGAÇÃO ---
    const showPage = (pageId) => {
        Object.values(pageElements).forEach(page => page.classList.remove('active'));
        document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
        
        const pageIdKey = pageId.replace(/-([a-z])/g, g => g[1].toUpperCase());
        
        if(renderPage[pageIdKey]) {
            renderPage[pageIdKey]();
        }

        if(pageElements[pageIdKey]) {
            pageElements[pageIdKey].classList.add('active');
        }
        const activeLink = document.querySelector(`.nav-link[data-page="${pageId}"]`);
        if(activeLink) {
            activeLink.classList.add('active');
        }
        
        lucide.createIcons();
    };

    // --- HANDLERS DE EVENTOS GLOBAIS ---
    window.app = {
        startWorkout: (routineId) => {
            const routine = state.routines.find(r => r.id === routineId);
            if (!routine) return;
            state.currentWorkout = {
                id: Date.now(),
                routineName: routine.name,
                date: new Date().toISOString(),
                exercises: JSON.parse(JSON.stringify(routine.exercises.map(ex => ({...ex, sets: [] })))),
                feedback: {}
            };
            showPage('log-workout');
        },
        cancelWorkout: () => {
             window.modal.showConfirm('Cancelar Treino', 'Tem certeza que deseja cancelar o treino atual? Todos os dados não salvos serão perdidos.', () => {
                state.currentWorkout = null;
                showPage('log-workout');
                window.modal.toast('Treino cancelado.');
            });
        },
        finishWorkout: async () => {
            if (state.currentWorkout.exercises.some(ex => ex.sets.length > 0)) {
                 window.modal.showFeedback(async (feedback) => {
                    state.currentWorkout.feedback = feedback;
                    
                    const workoutData = { ...state.currentWorkout };
                    // A ID local (timestamp) é útil para o histórico imediato, mas o Firestore usará seu próprio ID.
                    // Mantê-la não causa problemas.

                    const docRef = await addDoc(collection(db, `users/${state.userId}/workouts`), workoutData);

                    logic.updateAllGoalProgress();
                    state.currentWorkout = null;
                    window.modal.hide('feedback');
                    window.modal.toast('Treino salvo com sucesso!');
                    showPage('dashboard');
                });
            } else {
                window.modal.toast('Adicione pelo menos uma série para finalizar o treino.', false);
            }
        },
        addSet: (exIndex) => {
            const weightInput = document.getElementById(`weight-input-${exIndex}`);
            const repsInput = document.getElementById(`reps-input-${exIndex}`);
            const weight = parseFloat(weightInput.value);
            const reps = parseInt(repsInput.value);

            if (!isNaN(weight) && !isNaN(reps) && weight >= 0 && reps > 0) {
                state.currentWorkout.exercises[exIndex].sets.push({ weight, reps });
                weightInput.value = '';
                repsInput.value = '';
                weightInput.focus();
                renderPage.renderCurrentWorkout();
            } else {
                window.modal.toast("Insira valores válidos para carga e repetições.", false);
            }
        },
        removeSet: (exIndex, setIndex) => {
            state.currentWorkout.exercises[exIndex].sets.splice(setIndex, 1);
            renderPage.renderCurrentWorkout();
        },
        addRoutine: async () => {
            const input = document.getElementById('new-routine-name');
            if (input.value.trim()) {
                const newRoutine = { name: input.value.trim(), exercises: [] };
                await addDoc(collection(db, `users/${state.userId}/routines`), newRoutine);
                input.value = '';
                window.modal.toast('Rotina criada!');
            }
        },
        editRoutine: async (routineId) => {
            const routine = state.routines.find(r => r.id === routineId);
            if (!routine) return;
            
            window.modal.showEdit(`Editar Rotina: ${routine.name}`, routine.name, async (newName) => {
                if (newName && newName.trim() && newName.trim() !== routine.name) {
                    const finalNewName = newName.trim();
                    const routineRef = doc(db, `users/${state.userId}/routines`, routineId);
                    await setDoc(routineRef, { name: finalNewName }, { merge: true });
                    
                    window.modal.hide('edit');
                    window.modal.toast('Rotina atualizada.');
                }
            });
        },
        deleteRoutine: async (routineId) => {
            const routine = state.routines.find(r => r.id === routineId);
            if (!routine) return;

            window.modal.showConfirm('Excluir Rotina', `Tem certeza que deseja excluir a rotina "${routine.name}"?`, async () => {
                await deleteDoc(doc(db, `users/${state.userId}/routines`, routineId));
                window.modal.toast('Rotina excluída.');
            });
        },
        addExercise: async () => {
            const routineId = document.getElementById('manage-routine-select').value;
            const nameInput = document.getElementById('new-exercise-name');
            const muscleInput = document.getElementById('new-exercise-muscle');
            const name = nameInput.value.trim();
            const muscle = muscleInput.value.trim() || 'Geral';
            
            if (name) {
                const routine = state.routines.find(r => r.id === routineId);
                const updatedExercises = [...routine.exercises, {name, muscle}];
                const routineRef = doc(db, `users/${state.userId}/routines`, routineId);
                await setDoc(routineRef, { exercises: updatedExercises }, { merge: true });

                nameInput.value = '';
                muscleInput.value = '';
                window.modal.toast('Exercício adicionado.');
            }
        },
        editExercise: async (routineId, exIndex) => {
            const routine = state.routines.find(r => r.id === routineId);
            const oldEx = routine.exercises[exIndex];
            window.modal.showEditExercise(oldEx, async (newName, newMuscle) => {
                if (newName) {
                    const updatedExercises = [...routine.exercises];
                    updatedExercises[exIndex] = { name: newName, muscle: newMuscle };
                    
                    const routineRef = doc(db, `users/${state.userId}/routines`, routineId);
                    await setDoc(routineRef, { exercises: updatedExercises }, { merge: true });
                    
                    window.modal.hide('edit');
                    window.modal.toast('Exercício atualizado.');
                } else {
                    window.modal.toast('O nome do exercício não pode ser vazio.', false);
                }
            });
        },
         removeExercise: async (routineId, exIndex) => {
            const routine = state.routines.find(r => r.id === routineId);
            const updatedExercises = [...routine.exercises];
            updatedExercises.splice(exIndex, 1);
            
            const routineRef = doc(db, `users/${state.userId}/routines`, routineId);
            await setDoc(routineRef, { exercises: updatedExercises }, { merge: true });
            window.modal.toast('Exercício removido.');
        },
        addGoal: async () => {
            const exerciseName = document.getElementById('goal-exercise').value;
            const targetWeight = parseFloat(document.getElementById('goal-weight').value);
            const targetDate = document.getElementById('goal-date').value;

            if (!exerciseName || isNaN(targetWeight) || !targetDate) {
                window.modal.toast("Preencha todos os campos da meta.", false);
                return;
            }

            const currentPR = logic.getPRs(exerciseName);
            
            const newGoal = {
                exerciseName,
                targetWeight,
                targetDate,
                startingWeight: currentPR.weight,
                currentWeight: currentPR.weight,
            };

            await addDoc(collection(db, `users/${state.userId}/goals`), newGoal);
            window.modal.hide('edit');
            window.modal.toast("Nova meta criada com sucesso!");
        },
        deleteGoal: async (goalId) => {
             window.modal.showConfirm('Excluir Meta', `Tem certeza que deseja excluir esta meta?`, async () => {
                await deleteDoc(doc(db, `users/${state.userId}/goals`, goalId));
                window.modal.toast('Meta excluída.');
            });
        },
        deleteWorkout: async (workoutId) => {
            const workout = state.workouts.find(w => w.id === workoutId);
            if (!workout) return;
            
            window.modal.showConfirm('Excluir Treino', `Tem certeza que deseja excluir o treino "${workout.routineName}" de ${logic.formatDate(workout.date)}?`, async () => {
                await deleteDoc(doc(db, `users/${state.userId}/workouts`, workoutId));
                window.modal.toast('Treino excluído do histórico.');
            });
        },
        // --- Funções de Autenticação ---
        showLogin: () => {
            loginForm.classList.remove('hidden');
            signupForm.classList.add('hidden');
        },
        showSignUp: () => {
            loginForm.classList.add('hidden');
            signupForm.classList.remove('hidden');
        },
        login: async () => {
            const email = document.getElementById('login-email').value;
            const password = document.getElementById('login-password').value;
            try {
                await signInWithEmailAndPassword(auth, email, password);
            } catch (error) {
                console.error("Erro no login:", error.code, error.message);
                if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password' || error.code === 'auth/user-not-found') {
                    window.modal.toast("Email ou senha inválidos.", false);
                } else {
                     window.modal.toast("Falha no login. Verifique sua conexão.", false);
                }
            }
        },
        signup: async () => {
            const email = document.getElementById('signup-email').value;
            const password = document.getElementById('signup-password').value;
             if (password.length < 6) {
                window.modal.toast("A senha deve ter no mínimo 6 caracteres.", false);
                return;
            }
            try {
                const userCredential = await createUserWithEmailAndPassword(auth, email, password);
                const user = userCredential.user;

                // Adicionar rotinas padrão para novo usuário
                const defaultRoutines = [
                    { name: "Segunda - Peito, Ombro e Tríceps", exercises: [ { name: "Supino Reto", muscle: "Peito" }, { name: "Supino Inclinado", muscle: "Peito" }, { name: "Crucifixo", muscle: "Peito" }, { name: "Desenvolvimento", muscle: "Ombro" }, { name: "Elevação Frontal", muscle: "Ombro" }, { name: "Tríceps Corda", muscle: "Tríceps" } ]},
                    { name: "Terça - Costas e Bíceps", exercises: [ { name: "Puxada Frontal", muscle: "Costas" }, { name: "Remada Curvada", muscle: "Costas" }, { name: "Serrote", muscle: "Costas" }, { name: "Crucifixo Inverso", muscle: "Ombro" }, { name: "Rosca Direta", muscle: "Bíceps" }, { name: "Rosca Martelo", muscle: "Bíceps" } ]},
                    { name: "Quarta - Pernas", exercises: [ { name: "Agachamento Livre", muscle: "Quadríceps" }, { name: "Leg Press 45º", muscle: "Quadríceps" }, { name: "Stiff", muscle: "Posterior" }, { name: "Cadeira Flexora", muscle: "Posterior" }, { name: "Panturrilha em Pé", muscle: "Panturrilha" }, { name: "Panturrilha Sentado", muscle: "Panturrilha" } ]},
                    { name: "Sexta - Superior Completo", exercises: [ { name: "Supino Máquina", muscle: "Peito" }, { name: "Puxada Triângulo", muscle: "Costas" }, { name: "Elevação Lateral", muscle: "Ombro" }, { name: "Rosca Alternada", muscle: "Bíceps" }, { name: "Tríceps Francês", muscle: "Tríceps" } ]},
                    { name: "Sábado - Pernas 2", exercises: [ { name: "Cadeira Extensora", muscle: "Quadríceps" }, { name: "Agachamento Hack", muscle: "Quadríceps" }, { name: "Mesa Flexora", muscle: "Posterior" }, { name: "Elevação Pélvica", muscle: "Posterior" }, { name: "Panturrilha Leg Press", muscle: "Panturrilha" }, { name: "Panturrilha Smith", muscle: "Panturrilha" } ]}
                ];

                for (const routine of defaultRoutines) {
                    await addDoc(collection(db, `users/${user.uid}/routines`), routine);
                }

            } catch (error) {
                console.error("Erro no cadastro:", error.code, error.message);
                if (error.code === 'auth/email-already-in-use') {
                    window.modal.toast("Este email já está em uso.", false);
                } else {
                     window.modal.toast("Falha ao criar conta. Verifique sua conexão e a configuração do Firebase.", false);
                }
            }
        },
        logout: async () => {
            await signOut(auth);
        }
    };
    
    logic.updateAllGoalProgress = async () => {
        const goalsToUpdate = state.goals.map(async (goal) => {
            const currentPR = logic.getPRs(goal.exerciseName);
            if (goal.currentWeight !== currentPR.weight) {
                const goalRef = doc(db, `users/${state.userId}/goals`, goal.id);
                await setDoc(goalRef, { currentWeight: currentPR.weight }, { merge: true });
            }
        });
        await Promise.all(goalsToUpdate);
    };

    // --- INICIALIZAÇÃO DO FIREBASE ---
    const initFirebase = () => {
         const firebaseConfig = typeof __firebase_config !== 'undefined'
            ? JSON.parse(__firebase_config)
            : { 
                apiKey: "AIzaSyBkALEr1G1NpN2gbHTcaETMkeOIKiUBPaU",
                authDomain: "meuprogresso-252d1.firebaseapp.com",
                projectId: "meuprogresso-252d1",
                storageBucket: "meuprogresso-252d1.firebasestorage.app",
                messagingSenderId: "878116063684",
                appId: "1:878116063684:web:509ada02fb1da98ab07c91",
                measurementId: "G-7PC7P5GTE5"
              };
        
        // Esta verificação é para o ambiente de desenvolvimento local
        if (typeof __firebase_config === 'undefined' && firebaseConfig.apiKey === "AIzaSyBkALEr1G1NpN2gbHTcaETMkeOIKiUBPaU") {
             console.warn("Usando configuração de Firebase de exemplo. O login pode não funcionar corretamente.");
        }


        try {
            const app = initializeApp(firebaseConfig);
            auth = getAuth(app);
            db = getFirestore(app);

            onAuthStateChanged(auth, (user) => {
                if (user) {
                    // Usuário está logado
                    state.userId = user.uid;
                    authContainer.classList.add('hidden');
                    appContainer.classList.remove('hidden');
                    
                    // Limpa listeners antigos
                    if (unsubscribeRoutines) unsubscribeRoutines();
                    if (unsubscribeWorkouts) unsubscribeWorkouts();
                    if (unsubscribeGoals) unsubscribeGoals();

                    // Listener para Rotinas
                    const routinesQuery = query(collection(db, `users/${state.userId}/routines`));
                    unsubscribeRoutines = onSnapshot(routinesQuery, (snapshot) => {
                        state.routines = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                        const activePage = document.querySelector('.page.active')?.id.replace('page-', '');
                        if (['settings', 'logWorkout'].includes(activePage)) {
                            showPage(activePage);
                        }
                    });

                    // Listener para Treinos
                    const workoutsQuery = query(collection(db, `users/${state.userId}/workouts`));
                    unsubscribeWorkouts = onSnapshot(workoutsQuery, (snapshot) => {
                        state.workouts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                         const activePage = document.querySelector('.page.active')?.id.replace('page-', '');
                        if (['dashboard', 'history', 'analytics'].includes(activePage)) {
                            showPage(activePage);
                        }
                    });
                    
                    // Listener para Metas
                    const goalsQuery = query(collection(db, `users/${state.userId}/goals`));
                    unsubscribeGoals = onSnapshot(goalsQuery, (snapshot) => {
                        state.goals = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                         const activePage = document.querySelector('.page.active')?.id.replace('page-', '');
                        if (activePage === 'goals') {
                            showPage('goals');
                        }
                    });


                    showPage('dashboard');
                } else {
                    // Usuário está deslogado
                    state.userId = null;
                    state.routines = [];
                    state.workouts = [];
                    state.goals = [];
                    authContainer.classList.remove('hidden');
                    appContainer.classList.add('hidden');
                }
            });
        } catch (error) {
            console.error("ERRO GRAVE: Falha ao inicializar o Firebase. Verifique sua configuração.", error);
            authContainer.innerHTML = `<div class="text-center text-red-400">
                <h1 class="text-2xl font-bold">Erro de Configuração</h1>
                <p class="mt-2">Não foi possível conectar ao Firebase. Verifique se o objeto 'firebaseConfig' está correto no código.</p>
                </div>`;
        }
    };

    // --- INICIALIZAÇÃO GERAL ---
    const init = () => {
        initFirebase();
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', e => {
                e.preventDefault();
                const pageId = e.currentTarget.dataset.page;
                showPage(pageId);
            });
        });
        lucide.createIcons();
    };

    init();
});

