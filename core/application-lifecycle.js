'use strict';
const {createGracefulShutdown}=require('./graceful-shutdown');
const {createShutdownCoordinator}=require('./shutdown-coordinator');
const {createDatabaseCleanup}=require('./database-cleanup');
const {createLifecycleOrchestrator}=require('./lifecycle-orchestrator');
const installed=new WeakMap();
function installApplicationLifecycle({server,requestTracker,db,signals=process,report=console.log,timeoutMs=20000,gracePeriodMs=15000,cleanupTimeoutMs=2000}) {
    if(installed.has(server))return installed.get(server);
    const lifecycle=createLifecycleOrchestrator({
        shutdownCoordinator:createShutdownCoordinator({requestTracker,timeoutMs,
            gracefulShutdown:createGracefulShutdown({server,gracePeriodMs,cleanupTimeoutMs})}),
        databaseCleanup:createDatabaseCleanup({db})
    });
    let notification=null;
    function shutdown(){
        if(!notification)notification=lifecycle.shutdown().then(result=>{
            try{report(JSON.stringify({event:'application-shutdown',completed:result.completed,databaseClosed:result.databaseClosed,reason:result.reason}));}catch{}
            // Never force exit. An incomplete handler may still use SQLite.
            if(!result.completed)signals.exitCode=1;
            return result;
        },()=>{signals.exitCode=1;return {completed:false,databaseClosed:false,reason:'lifecycle-failed'};});
        return notification;
    }
    const onSignal=()=>{void shutdown();};
    signals.on('SIGINT',onSignal);signals.on('SIGTERM',onSignal);
    const api=Object.freeze({shutdown,getState:lifecycle.getState});installed.set(server,api);return api;
}
module.exports={installApplicationLifecycle};
