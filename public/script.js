document.addEventListener('DOMContentLoaded', () => {
    fetchUsers();
    setupTabs();
    setupModal();
});

// ====== PESTAÑAS ======
function setupTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
            
            if(btn.dataset.tab === 'tab-list') fetchUsers();
        });
    });
}

// ====== MODAL DETALLES ======
const modal = document.getElementById('editModal');
const closeBtn = document.querySelector('.close-btn');

function setupModal() {
    closeBtn.onclick = () => modal.style.display = "none";
    window.onclick = (event) => {
        if (event.target == modal) modal.style.display = "none";
    }
}

function openEditModal(userObj) {
    document.getElementById('editOriginalUsername').value = userObj.username;
    document.getElementById('editUsername').value = userObj.username;
    document.getElementById('editPassword').value = '';
    
    document.getElementById('editCanRead').checked = userObj.canRead;
    document.getElementById('editCanWrite').checked = userObj.canWrite;
    
    modal.style.display = "block";
}

document.getElementById('editUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const original = document.getElementById('editOriginalUsername').value;
    const newUsername = document.getElementById('editUsername').value;
    const password = document.getElementById('editPassword').value;
    const canRead = document.getElementById('editCanRead').checked;
    const canWrite = document.getElementById('editCanWrite').checked;
    
    const btnText = document.getElementById('editBtnText');
    const loader = document.getElementById('editLoader');
    btnText.style.display = 'none';
    loader.style.display = 'block';
    
    try {
        const res = await fetch(`/api/users/${original}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newUsername, password, canRead, canWrite })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        
        showNotification(data.message, 'success');
        modal.style.display = "none";
        fetchUsers();
    } catch (err) {
        showNotification(err.message, 'error');
    } finally {
        btnText.style.display = 'block';
        loader.style.display = 'none';
    }
});


// ====== USUARIOS RESULTADOS ======
async function fetchUsers() {
    const tableLoader = document.getElementById('tableLoader');
    const usersList = document.getElementById('usersList');
    
    tableLoader.style.display = 'block';
    tableLoader.classList.add('dark');
    usersList.innerHTML = '';

    try {
        const response = await fetch('/api/users');
        const users = await response.json();
        
        users.forEach(user => {
            const row = document.createElement('tr');
            row.className = `user-row ${!user.active ? 'inactive' : ''}`;
            
            let permText = '';
            if (user.canRead && user.canWrite) permText = 'Lectura y Escritura';
            else if (user.canRead && !user.canWrite) permText = 'Sólo Lectura';
            else permText = 'Sin Acceso';
            
            row.innerHTML = `
                <td>${user.username}</td>
                <td class="center">${permText}</td>
                <td class="center">
                    <span class="badge ${user.active ? 'active' : 'inactive'}">
                        ${user.active ? 'Activo' : 'Inactivo'}
                    </span>
                </td>
                <td class="right">
                    <button class="action-btn" onclick='openEditModal(${JSON.stringify(user)})'>Editar</button>
                    <button class="action-btn" onclick="toggleStatus('${user.username}', ${!user.active})">
                        ${user.active ? 'Desactivar' : 'Activar'}
                    </button>
                    <button class="action-btn delete" onclick="deleteUser('${user.username}')">Eliminar</button>
                </td>
            `;
            usersList.appendChild(row);
        });
        
    } catch (error) {
        showNotification("Error al cargar", "error");
    } finally {
        tableLoader.style.display = 'none';
    }
}

// 2. Crear Usuario
document.getElementById('createUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const btnText = document.querySelector('#createUserForm .btn-text');
    const loader = document.querySelector('#createUserForm .loader');
    
    btnText.style.display = 'none';
    loader.style.display = 'block';
    
    try {
        const response = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        
        showNotification(data.message, 'success');
        document.getElementById('createUserForm').reset();
        document.querySelector('[data-tab="tab-list"]').click(); 
    } catch (error) {
        showNotification(error.message, 'error');
    } finally {
        btnText.style.display = 'block';
        loader.style.display = 'none';
    }
});

// 4. Activar / Desactivar
async function toggleStatus(username, activeStatus) {
    try {
        await fetch(`/api/users/${username}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: activeStatus })
        });
        fetchUsers(); 
    } catch (error) {}
}

// 5. Eliminar usuario
async function deleteUser(username) {
    if (!confirm(`¿Borrar a ${username} permanentemente de la red?`)) return;
    try {
        await fetch(`/api/users/${username}`, { method: 'DELETE' });
        showNotification(`Usuario eliminado`, "success");
        fetchUsers();
    } catch (error) {}
}

function showNotification(message, type) {
    const notification = document.getElementById('notification');
    notification.textContent = message;
    notification.className = `notification show ${type}`;
    setTimeout(() => notification.classList.remove('show'), 3000);
}
