import { app } from 'electron'
import { join } from 'node:path'

app.setName('CaoGen')
app.setPath('userData', process.env.CAOGEN_USER_DATA_DIR || join(app.getPath('appData'), 'CaoGen'))
