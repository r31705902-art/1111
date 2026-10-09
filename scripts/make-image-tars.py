# Сборка docker-save архивов БЕЗ docker (так собраны images/*.tar.gz). Нужны слои node:24-alpine и static-ffmpeg в /data/build.
import json,tarfile,hashlib,io,os,gzip,shutil,time,sys
B='/data/build'; SRC='/data/V_N'; OUT=sys.argv[1]; which=sys.argv[2].split(',')
MT=int(time.time())
def sha(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1<<20),b''): h.update(b)
    return h.hexdigest()
def ungz(src,dst):
    if not os.path.exists(dst):
        with gzip.open(src,'rb') as i, open(dst,'wb') as o: shutil.copyfileobj(i,o,1<<20)
    return dst
base_cfg=json.load(open(f'{B}/base/config.json'))
base_layers=[ungz(f'{B}/base/layer{i}.tgz',f'{B}/base/layer{i}.tar') for i in range(4)]
for p,d in zip(base_layers,base_cfg['rootfs']['diff_ids']): assert 'sha256:'+sha(p)==d,p
def dirent(t,name,uid=0,mode=0o755):
    ti=tarfile.TarInfo(name); ti.type=tarfile.DIRTYPE; ti.mode=mode; ti.uid=ti.gid=uid; ti.mtime=MT; t.addfile(ti)
def addtree(t,src,arc):
    dirent(t,arc)
    for root,ds,fs in os.walk(src):
        ds.sort()
        for d in ds: dirent(t,os.path.join(arc,os.path.relpath(os.path.join(root,d),src)))
        for f in sorted(fs):
            p=os.path.join(root,f); ti=t.gettarinfo(p,os.path.join(arc,os.path.relpath(p,src)))
            ti.uid=ti.gid=0; ti.uname=ti.gname='root'; ti.mode=0o755 if os.access(p,os.X_OK) else 0o644; ti.mtime=MT
            with open(p,'rb') as fh: t.addfile(ti,fh)
def layer(path,fn):
    if not os.path.exists(path):
        with tarfile.open(path,'w',format=tarfile.GNU_FORMAT) as t: fn(t)
    return path
IM={
 'main':dict(env=['NODE_ENV=production','PORT=10000','DATA_DIR=/data'],cmd=['node','--disable-warning=ExperimentalWarning','--max-old-space-size=300','main/src/server.js'],user='node',hc=True,data=True),
 'edge':dict(env=['NODE_ENV=production','PORT=10000'],cmd=['node','--max-old-space-size=160','edge/src/edge.js'],user='node'),
 'bot':dict(env=['NODE_ENV=production','PORT=10000'],cmd=['node','--max-old-space-size=96','bot/src/bot.js'],user='node'),
 'encoder':dict(env=['NODE_ENV=production','WORK_DIR=/work'],ep=['node','encoder/src/encoder.js'],cmd=['worker'],user='',ff=True,vol='/work'),
}
L=f'{B}/layers'; os.makedirs(L,exist_ok=True)
shared=layer(f'{L}/shared.tar',lambda t:(dirent(t,'app'),addtree(t,f'{SRC}/shared','app/shared')))
ffl=None
manifest=[]; files={}
for n in which:
    c=IM[n]; extra=[]
    if c.get('ff'):
        def f(t):
            dirent(t,'usr'); dirent(t,'usr/local'); dirent(t,'usr/local/bin')
            for b in ('ffmpeg','ffprobe'):
                ti=t.gettarinfo(f'{B}/ffx/{b}',f'usr/local/bin/{b}'); ti.uid=ti.gid=0; ti.mode=0o755; ti.mtime=MT
                with open(f'{B}/ffx/{b}','rb') as fh: t.addfile(ti,fh)
        extra.append(layer(f'{L}/ffmpeg.tar',f))
    extra.append(shared)
    def app(t,n=n,c=c):
        dirent(t,'app'); addtree(t,f'{SRC}/{n}',f'app/{n}')
        if c.get('data'): dirent(t,'data',uid=1000)
        if c.get('vol'): dirent(t,c['vol'].strip('/'))
    extra.append(layer(f'{L}/{n}.tar',app))
    cfg=json.loads(json.dumps(base_cfg)); cc=cfg['config']
    env=[e for e in cc['Env'] if not any(e.split('=')[0]==x.split('=')[0] for x in c['env'])]+c['env']
    cc.update(Env=env,Cmd=c['cmd'],WorkingDir='/app',User=c['user'])
    cc['Entrypoint']=c.get('ep',['docker-entrypoint.sh'])
    if n!='encoder': cc['ExposedPorts']={'10000/tcp':{}}
    if c.get('vol'): cc['Volumes']={c['vol']:{}}
    if c.get('hc'): cc['Healthcheck']={'Test':['CMD-SHELL','wget -qO- http://127.0.0.1:${PORT}/health || exit 1'],'Interval':60_000_000_000,'Timeout':5_000_000_000}
    cc['Labels']={'org.opencontainers.image.title':f'vn-{n}','org.opencontainers.image.description':'V_N stream archive'}
    cfg['created']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(MT))
    for p in extra:
        cfg['rootfs']['diff_ids'].append('sha256:'+sha(p)); cfg['history'].append({'created':cfg['created'],'created_by':'V_N build: '+os.path.basename(p)})
    cb=json.dumps(cfg,separators=(',',':')).encode(); ch=hashlib.sha256(cb).hexdigest()
    files[f'{ch}.json']=cb
    lays=[]
    for p in base_layers+extra:
        h=sha(p); files.setdefault(f'{h}/layer.tar',p); lays.append(f'{h}/layer.tar')
    manifest.append({'Config':f'{ch}.json','RepoTags':[f'vn-{n}:latest'],'Layers':lays})
    print(n,'config',ch[:12],'layers',len(lays))
with gzip.open(OUT,'wb',compresslevel=6) as g, tarfile.open(fileobj=g,mode='w',format=tarfile.GNU_FORMAT) as t:
    def addb(name,b):
        ti=tarfile.TarInfo(name); ti.size=len(b); ti.mtime=MT; t.addfile(ti,io.BytesIO(b))
    for k,v in files.items():
        if isinstance(v,bytes): addb(k,v)
        else:
            dirent(t,k.split('/')[0]); t.add(v,k)
    addb('manifest.json',json.dumps(manifest).encode())
    addb('repositories',json.dumps({f'vn-{m["RepoTags"][0].split(":")[0][3:]}' if False else m['RepoTags'][0].split(':')[0]:{'latest':m['Layers'][-1].split('/')[0]} for m in manifest}).encode())
print('ok',OUT,os.path.getsize(OUT))
