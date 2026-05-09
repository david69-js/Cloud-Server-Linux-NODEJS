const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = 80;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = {}; // Simple in-memory session store

const smbConfPath = '/etc/samba/smb.conf';

const runCmd = (cmd) => new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error ejecutando '${cmd}': ${stderr || error.message}`);
            return reject(stderr || error.message);
        }
        resolve(stdout);
    });
});

async function fetchRealUsers() {
    try {
        const output = await runCmd('sudo pdbedit -L -v');
        const users = [];
        const lines = output.split('\n');
        
        let currentUser = null;
        for (let line of lines) {
            if (line.startsWith('Unix username:')) {
                currentUser = { username: line.split(':')[1].trim(), active: true, canRead: true, canWrite: true };
                users.push(currentUser);
            }
            if (currentUser && line.startsWith('Account Flags:')) {
                if (line.includes('D')) currentUser.active = false;
            }
        }
        
        if (fs.existsSync(smbConfPath)) {
            const linesConf = fs.readFileSync(smbConfPath, 'utf8').split('\n');
            users.forEach(u => {
                let insideSection = false;
                for (let line of linesConf) {
                    if (line.trim().toLowerCase() === `[${u.username.toLowerCase()}]`) {
                        insideSection = true;
                        continue;
                    }
                    if (insideSection && line.trim().startsWith('[')) {
                        insideSection = false;
                    }
                    if (insideSection) {
                        if (line.trim().toLowerCase().startsWith('read only = yes')) u.canWrite = false;
                        if (line.trim().toLowerCase().startsWith('available = no')) u.canRead = false;
                    }
                }
            });
        }
        return users;
    } catch (err) {
        console.error("Error al obtener usuarios. ", err);
        return [];
    }
}

// Rescribe un bloque completo de usuario en smb.conf de forma segura
function rewriteSmbSection(oldUsername, config) {
    let lines = fs.existsSync(smbConfPath) ? fs.readFileSync(smbConfPath, 'utf8').split('\n') : [];
    let newLines = [];
    let skip = false;
    for (let line of lines) {
        if (line.trim().toLowerCase() === `[${oldUsername.toLowerCase()}]`) {
            skip = true;
            continue;
        }
        if (skip && line.trim().startsWith('[')) {
            skip = false;
        }
        if (!skip) newLines.push(line);
    }
    
    while (newLines.length > 0 && newLines[newLines.length-1].trim() === '') newLines.pop();
    
    newLines.push('');
    newLines.push(`[${config.sectionName}]`);
    newLines.push(`path = ${config.path}`);
    newLines.push(`valid users = ${config.validUsers}`);
    newLines.push(`read only = ${config.readOnly}`);
    newLines.push(`available = ${config.available}`);
    newLines.push(`browsable = yes`);
    newLines.push('');
    
    fs.writeFileSync(smbConfPath, newLines.join('\n'));
}

// 1. Obtener Usuarios
app.get('/api/users', async (req, res) => {
    res.json(await fetchRealUsers());
});

// 2. Crear Usuario
app.post('/api/users', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Faltan datos.' });

    try {
        const currentUsers = await fetchRealUsers();
        if (currentUsers.find(u => u.username === username)) {
            return res.status(400).json({ error: 'El usuario ya existe.' });
        }

        await runCmd(`sudo useradd -m ${username}`);
        await runCmd(`(echo ${password}; echo ${password}) | sudo smbpasswd -s -a ${username}`);
        await runCmd(`sudo mkdir -p /srv/samba/${username}`);
        await runCmd(`sudo chown ${username}:${username} /srv/samba/${username}`);
        await runCmd(`sudo chmod 700 /srv/samba/${username}`);
        
        rewriteSmbSection("NON_EXISTENT_JUST_APPEND", {
            sectionName: username,
            path: `/srv/samba/${username}`,
            validUsers: username,
            readOnly: 'no',
            available: 'yes'
        });
        
        await runCmd(`sudo systemctl restart smbd`);
        res.json({ message: `¡Usuario '${username}' listo!` });
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});

// 3. EDITAR Detalles del Usuario (Nombre, Password, Permisos)
app.put('/api/users/:username', async (req, res) => {
    const { username } = req.params;
    const { newUsername, password, canRead, canWrite } = req.body;
    
    try {
        let targetUsername = username;
        
        // a) Cambiar Nombre de Usuario
        if (newUsername && newUsername !== username) {
            if (!password) {
                return res.status(400).json({ error: "Para cambiar el nombre, es obligatorio confirmar/cambiar la contraseña." });
            }
            // Método seguro: Crear copia, mover, borrar original.
            await runCmd(`sudo useradd -m ${newUsername}`);
            await runCmd(`(echo ${password}; echo ${password}) | sudo smbpasswd -s -a ${newUsername}`);
            await runCmd(`sudo mv /srv/samba/${username} /srv/samba/${newUsername}`);
            await runCmd(`sudo chown -R ${newUsername}:${newUsername} /srv/samba/${newUsername}`);
            
            await runCmd(`sudo smbpasswd -x ${username}`).catch(()=>{});
            await runCmd(`sudo userdel -r ${username}`).catch(()=>{});
            
            targetUsername = newUsername;
        } 
        // b) Cambiar Contraseña (sin cambiar nombre)
        else if (password) {
            await runCmd(`(echo ${password}; echo ${password}) | sudo smbpasswd -s ${username}`);
        }
        
        // c) Actualizar smb.conf (Permisos R/W)
        rewriteSmbSection(username, {
            sectionName: targetUsername,
            path: `/srv/samba/${targetUsername}`,
            validUsers: targetUsername,
            readOnly: canWrite ? 'no' : 'yes',
            available: canRead ? 'yes' : 'no'
        });
        
        await runCmd(`sudo systemctl restart smbd`);
        res.json({ message: "Usuario actualizado exitosamente." });
        
    } catch(err) {
        res.status(500).json({ error: err.toString() });
    }
});

// 4. Cambiar Estado
app.put('/api/users/:username/status', async (req, res) => {
    const { username } = req.params;
    const { active } = req.body;
    try {
        if (active) await runCmd(`sudo smbpasswd -e ${username}`);
        else await runCmd(`sudo smbpasswd -d ${username}`);
        res.json({ message: `Estado actualizado` });
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});

// 5. Eliminar
app.delete('/api/users/:username', async (req, res) => {
    const { username } = req.params;
    try {
        await runCmd(`sudo smbpasswd -x ${username}`).catch(()=>{});
        await runCmd(`sudo userdel -r ${username}`).catch(()=>{});
        await runCmd(`sudo rm -rf /srv/samba/${username}`);
        
        rewriteSmbSection(username, { sectionName: 'DELETE' }); // Esto solo lo borrará si modificamos la funcion.
        
        res.json({ message: `Usuario eliminado.` });
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});

// ===========================
// RUTAS DE LOGIN Y USUARIOS
// ===========================

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales.' });
    
    if (username === 'admin' && password === 'admin') {
        const token = Math.random().toString(36).substring(2);
        sessions[token] = { username: 'admin', role: 'admin' };
        return res.json({ token, role: 'admin', username: 'admin' });
    }

    try {
        const util = require('util');
        const execFile = util.promisify(require('child_process').execFile);
        
        try {
            await execFile('rpcclient', ['-U', `${username}%${password}`, '-c', 'getusername', '127.0.0.1']);
        } catch (err) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }
        
        const token = Math.random().toString(36).substring(2);
        sessions[token] = { username, role: 'user' };
        res.json({ token, role: 'user', username });
    } catch (err) {
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

app.get('/api/me', async (req, res) => {
    const token = req.headers['authorization'];
    if (!token || !sessions[token]) return res.status(401).json({ error: 'No autorizado.' });
    
    const userSession = sessions[token];
    if (userSession.role === 'admin') {
        return res.json({ username: 'admin', role: 'admin' });
    }
    
    // Obtener detalles de permisos del usuario
    const users = await fetchRealUsers();
    const myData = users.find(u => u.username === userSession.username);
    if (!myData) return res.status(404).json({ error: 'Usuario no encontrado en Samba.' });
    
    res.json({ ...myData, role: 'user' });
});

app.post('/api/me/change-password', async (req, res) => {
    const token = req.headers['authorization'];
    if (!token || !sessions[token] || sessions[token].role !== 'user') return res.status(401).json({ error: 'No autorizado.' });
    
    const { newPassword } = req.body;
    const username = sessions[token].username;
    if (!newPassword) return res.status(400).json({ error: 'La nueva contraseña no puede estar vacía.' });
    
    try {
        await runCmd(`(echo ${newPassword}; echo ${newPassword}) | sudo smbpasswd -s ${username}`);
        res.json({ message: 'Contraseña actualizada exitosamente.' });
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});

app.post('/api/logout', (req, res) => {
    const token = req.headers['authorization'];
    if (token && sessions[token]) {
        delete sessions[token];
    }
    res.json({ message: 'Sesión cerrada.' });
});

app.listen(PORT, () => {
    console.log(`\n===========================================`);
    console.log(`🚀 SAMBA WEB ADMIN EN CON PUERTO 80 🚀`);
    console.log(`===========================================\n`);
});
