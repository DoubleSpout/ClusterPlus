/*启动cluster,并且根据设置启动多个node.js进程监听不同端口，并且自动重启*/
var cluster = require('cluster'),
	AsyncProxy = require('./AsyncProxy'),//加载 AsyncProxy 异步管理库，虽然小，但是强悍！
	reload = require('./reload'),//加载reloadjs模块，当有文件改动时，自动重启所有子进程
	killz = require('./KillZombie'),//杀死僵尸进程，linux有效
		util = require('util'),
	settings = {//默认配置
		logger:false,
		num: 1,
		CreateCallback:function(){},
		DeadCallback:function(){},
		RestartCallback:function(){},
		reload:true
	};	
var ClusterPlus = module.exports = function(setting){//主进程类
		var that = this,
			me = arguments.callee,
			setting = setting || {};
		if(!(this instanceof me)) return new me(setting);//实例化ClusterPlus
		if(cluster.isWorker) return new ClusterChild(that._serialsettings(setting));//如果是子进程
		this.workobj = [];//存放childprocessid的数组
		this._dead = []; //存放挂掉的childprocess序号
		this._overProcess = [];
		this.async = AsyncProxy();//实例化AsyncProxy异步代理类，这里使用链式调用，一个个启动进程
		Object.defineProperty(this, "_PidGetNum",{set:function(newValue){//定义 _PidGetNum 属性
				var num = that.workobj.indexOf(newValue);
				if(~num) _PidGetNum = {num:num, pid:newValue}; //知道指定pid的num
				else _PidGetNum=false;//当找到指定的pid的num,返回V对象，否则返回FALSE
		},get:function(){return _PidGetNum;},enumerable:false});
		this._intial(that._serialsettings(setting));//初始化setting对象
		if(this.reload && ('undefined' != typeof setting.reload || that.num == 1)){//配置reload.js模块,默认只有num:1时才开启relaod
			var file = this.reload == true?'':this.reload;
			me.reload = reload(file, {interval:that.num*1500})(this);
			killz(this);//启动僵尸进程消灭函数
		}
	}		
ClusterPlus.prototype = {
		__proto__:cluster,
		_create:function(num, callback){//fork子进程
			var that = this,
				callback = callback || function(){};
				cluster.fork().on('message', function(data){
					   if(typeof data._pid != 'undefined'){//接收子进程的pid，存入 ClusterPlus.workobj 数组中
						   var num = data._num, pid = data._pid;
						   if(that.workobj[num]){
								that._overProcess.push(pid);
								that._kill([pid]);
						   }
						   else {
							  that._dead = that._dead.filter(function(val){
									 return val != num;
									})
							  that._PidGetNum = that.workobj[num] = pid;
							  callback(null, that._PidGetNum);
						   }
					   }
			  		}).send({_num:num});//发送次子进程的序号
				that._output('子进程第 '+num+'个，已经启动。');
				return that;
			},
		_output : function(str){//对外输出
				if(this.logger) 'function'== typeof this.logger?this.logger(str):console.log(str);
				return this;
			},
		_restart:function(num, callback){//重新启动核心函数
				var num =  'object' != typeof num?[num]:num,
					that = this,
					callback = callback || function(){}
					async = [];//存放 AsyncProxy 异步代理调用的参数
				num.forEach(function(value, i){
					if(parseInt(value) != value) return;
					async.push(function(value){//闭包，将异步代理的回调函数存入数组中
									return function(order){
										that._create(value, function(err, data){
											that.RestartCallback(err, data);									
											that.async.rec(order);//异步代理 AsyncProxy 方法，表示异步已经返回
										});
											};
						}(value));
					that._output('已经开始重启第 '+value+'个子进程。');
				});
				async.push(callback);
				that.async.ap.apply(that.async, async);
				return this;
			},
		_checkOverProcess:function(pid){
			var that = this,
				len = this._overProcess.length;
			this._overProcess = this._overProcess.filter(function(val){
				if(val == pid) that._output('多余的进程已经杀死，进程号：'+pid);
				return val != pid
			})
			return this._overProcess.length != len;
			},
		_serialsettings:function(setting){//序列化用户传递的setting属性，修改为私有属性，不可写，不可枚举
				if('object' != typeof setting) settings.num = setting || settings.num;
				else{
					for(var key in setting) settings[key] = setting[key];	
				}
				for(var key in settings) Object.defineProperty(this, key, {value:settings[key], writable:false, enumerable:false});			
				return settings;
			},
		_ondeath:function(){
				var that = this;
				  cluster.on('death', function(worker){//增加子进程监听函数，当death触发
						if(that._checkOverProcess(worker.pid)) return;
						that._output('worker ' + worker.pid + ' 挂掉了！');
						that._PidGetNum = worker.pid;
						if(that._PidGetNum){//如果能根据pid找到子进程num值，则
								that.workobj[that._PidGetNum.num] = false;
								if(!that._dead.some(function(val){return val == that._PidGetNum.num})) that._dead.push(that._PidGetNum.num);								
								that._restart(that._PidGetNum.num).DeadCallback(null, that._PidGetNum);
							}
						else {//如果找不到子进程值，则认为异常退出
							that._output('子进程可能有语法错误，异常退出：'+worker.pid);		
						}
				});
				return this;
			},
		_intial : function(setting){//初始化函数
				while(setting.num--) this._create(setting.num);
				this._ondeath();
				return this;
			},
		_kill : function(ary){//杀死数组中的进程pid
				var that = this;
					ary.forEach(function(pid){
						if(pid){
							try{
								process.kill(pid, 'SIGTERM');
								}
							catch(err) {
								that._output('杀死进程'+pid+'失败：'+err)._PidGetNum = pid;
								}	
						}
					})		
				return this;						
			},
		restart:function(pid){//对外Api，可以根据pid来重启子进程，不传参数示为全部重启
			var that = this,
				pid = pid||this.workobj,
			    ary = 'object' != typeof pid?[pid]:pid,
				RestartAll = function(ary){//如果杀死失败，则将错误的子进程序号存入_dead数组中
							that._dead.length = 0;
							that._kill(ary);
				};		
			if(that._dead.length>0) that._restart(that._dead, function(){RestartAll(ary)});
			else RestartAll(ary);
			return this;
		}
		// restart 结束
	}		
var ClusterChild = function(setting){//子进程类
	Object.defineProperty(this, 'pid' , {value:process.pid, writable:false});
	this._listen(setting);
	}
ClusterChild.prototype={
	__proto__:cluster,
	_listen:function(setting){
		var that = this;
		process.on('message', function(data) {
			try{
				if('undefined' != typeof data._num){
					process.send({_pid:that.pid, _num:data._num}); 	
					setting.CreateCallback(null, {num:data._num, pid:that.pid});
				}
			}
			catch(err){
				ClusterPlus.prototype._output.call(setting, '子进程接收message出现错误: '+err);
				setting.CreateCallback('Fail to get message:'+err);
				}	 
			});	
		process.on('SIGTERM', function(data) {
			ClusterPlus.prototype._output.call(setting, '收到重启信息，子进程  '+that.pid+'  关闭中...');
			process.exit(0);
		})
	}	
}